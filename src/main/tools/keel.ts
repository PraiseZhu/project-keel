// Main-control protocol: keel_run / report / wait / gate / status.
// Sol follows next; this module wires interpreter, gates, done facts, brief, index, and view.

import { family } from "../../shared/fanout.ts";
import { loadRuntimeConfig } from "../config.ts";
import { node, requireString, type ToolContext } from "../context.ts";
import { loadGraphStates } from "../graph-snapshot.ts";
import { isChangeGraphDone, isInvestigationDone, type ChangeGraphDoneInput, type ChangeGraphDoneResult, type ScRow } from "../graph/done.ts";
import { GATES, type Evidence, type GateId } from "../graph/gates.ts";
import { isGraphTaskType, resolveGraphTask, routePendingPath, type RoutePending } from "../graph/route-start.ts";
import { ASTRA_CONSULT_ID, classifyRetry, createRun, advance, type AdvanceEvent, type AdvanceOpts, type AdvanceResult, type DoneCheckResult, type GateHooks, type ReconcileQueries } from "../graph/interpreter.ts";
import { readPrFacts, type PrFacts } from "../graph/pr-facts.ts";
import { NODE_REPORT_STATUSES, parseNodeReport, type NodeReport } from "../graph/report.ts";
import { checkScope } from "../graph/scope.ts";
import { ensureNode, parseDispatchKey, type ErrorMode, type GateAnswer, type GraphRunState, type Next, type NodeReportSnap, type SuccessCriterion, type Verdict } from "../graph/state.ts";
import { confirmLedgerHead, recordVerifierVerdict } from "../graph/verdict-sink.ts";
import { buildVerdict, type GraphVerdict, type NodeReport as VerdictReport } from "../graph/verdict.ts";
import { KeelError, type Host } from "../host.ts";
import { runGate, type GateDecision, type GateStore, type GraphKind } from "../jev/gates.ts";
import { newRunId } from "../ledger.ts";
import { findProfile, resolveProfileForHarness } from "../manual/resolve.ts";
import { toActiveIndex, writeActiveIndex } from "../store/active-index.ts";
import { withRun, writeRunArtifact } from "../store/runs.ts";
import { PSTACK_GRAPHS, type GraphTaskType } from "../../shared/graph/pstack.ts";
import type { Harness, ModelManual, Profile } from "../../shared/manual/schema.ts";
import { countWaitCiRuns, pollIntervalMs } from "../graph/poll.ts";
import { collectTaskMessages, invokeCindyTasks, type PluginTaskInput } from "../host/tasks.ts";

const LEADS = new Set<Harness>(["codex", "claude-code", "pi"]);
const CHANGE_TYPES = new Set(["bug-fix", "feature", "refactoring", "pr"]);

/** G-advance predecessors in the unit graphs. ran[] stays raw; only this adapter maps acceptance. */
export const ADVANCE_PREDECESSORS = ["research", "verify-same-surface", "equivalence"] as const;

/**
 * Acceptance for G-advance, never a rewrite of the report's ran[].
 * verify-same-surface: original tests now pass → 0.
 * equivalence: check commands pass → 0.
 * research: no test command, omit exit_code.
 */
export function acceptanceExitCode(nodeId: string, ran: readonly { cmd: string; exit_code: number }[]): number | undefined {
  if (nodeId === "research") return undefined;
  if (nodeId === "verify-same-surface" || nodeId === "equivalence") {
    if (!ran.length) return undefined;
    return ran.every((r) => r.exit_code === 0) ? 0 : 1;
  }
  return undefined;
}

export function advanceEvidenceForNode(input: {
  nodeId: string;
  ran?: readonly { cmd: string; exit_code: number }[];
  head_matches?: boolean;
  new_report?: boolean;
  new_commit?: boolean;
}): Evidence {
  const ran = input.ran ?? [];
  const code = acceptanceExitCode(input.nodeId, ran);
  return {
    evidence_present: ran.length > 0 || input.nodeId === "research",
    ...(input.head_matches !== undefined ? { head_matches: input.head_matches } : {}),
    ...(code !== undefined ? { exit_code: code } : {}),
    new_evidence: input.new_report === true || input.new_commit === true,
  };
}

export function normalizeListWorkers(raw: unknown): NonNullable<ReconcileQueries["list_workers"]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, complete: false };
  const o = raw as Record<string, unknown>;
  const ok = o.ok === true;
  const workers = Array.isArray(o.workers)
    ? o.workers.map((row) => {
        const w = rec(row);
        const worker_id = str(w.worker_id) ?? str(w.workerId);
        const worker_session_id = str(w.worker_session_id) ?? str(w.sessionId) ?? str(w.workerSessionId);
        return {
          label: str(w.label) ?? "",
          ...(worker_id ? { worker_id } : {}),
          ...(worker_session_id ? { worker_session_id } : {}),
          ...(str(w.status) ? { status: str(w.status) } : {}),
        };
      })
    : undefined;
  const count = typeof o.count === "number" ? o.count : undefined;
  const complete = ok && Array.isArray(workers) && (count === undefined || count === workers.length);
  const team_id = str(o.team_id) ?? str(o.teamId);
  return {
    ok,
    complete,
    ...(workers ? { workers } : {}),
    ...(team_id ? { team_id } : {}),
    ...(typeof o.errorCode === "string" ? { errorCode: o.errorCode } : {}),
  };
}

export function mapCreateWorkerReceipt(raw: unknown): {
  worker_id?: string;
  worker_session_id?: string;
  queued_message_id?: string;
  dispatch_outcome: { created?: boolean; delivered?: boolean; queued?: boolean; errorCode?: string };
} {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const outcome = o.dispatch_outcome && typeof o.dispatch_outcome === "object" ? (o.dispatch_outcome as Record<string, unknown>) : o;
  const worker_id = str(o.worker_id) ?? str(o.workerId);
  const worker_session_id = str(o.worker_session_id) ?? str(o.workerSessionId);
  const queued_message_id = str(o.queued_message_id) ?? str(o.queuedMessageId);
  const dispatched = outcome.dispatched === true;
  const wakeKind = str(outcome.wakeKind);
  return {
    ...(worker_id ? { worker_id } : {}),
    ...(worker_session_id ? { worker_session_id } : {}),
    ...(queued_message_id ? { queued_message_id } : {}),
    dispatch_outcome: {
      created: Boolean(worker_id),
      delivered: dispatched && wakeKind !== "queued",
      queued: wakeKind === "queued" || Boolean(queued_message_id),
      ...(str(outcome.errorCode) ? { errorCode: str(outcome.errorCode) } : {}),
    },
  };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function workflowObj(src: Record<string, unknown>): Record<string, unknown> | undefined {
  // Worker session: get_workspace_info.workflow is null → this source has no team.
  if ("workflow" in src && (src.workflow === null || src.workflow === undefined)) return undefined;
  if (src.workflow && typeof src.workflow === "object" && !Array.isArray(src.workflow)) return src.workflow as Record<string, unknown>;
  return src;
}

/** start_team receipt first, else get_workspace_info.workflow.workflow_id. workflow:null = no team. */
export function resolveTeamId(...sources: unknown[]): string | undefined {
  for (const src of sources) {
    if (!src || typeof src !== "object" || Array.isArray(src)) continue;
    const o = src as Record<string, unknown>;
    if ("workflow" in o && (o.workflow === null || o.workflow === undefined)) continue;
    const wf = workflowObj(o);
    const id = str(o.team_id) ?? str(o.teamId) ?? str(o.workflow_id) ?? str(o.workflowId)
      ?? (wf ? str(wf.workflow_id) ?? str(wf.workflowId) ?? str(wf.team_id) : undefined);
    if (id) return id;
  }
  return undefined;
}

/** Main-control session may take get_workspace_info.workflow.lead_session_id. */
export function resolveLeadSessionId(...sources: unknown[]): string | undefined {
  for (const src of sources) {
    if (!src || typeof src !== "object" || Array.isArray(src)) continue;
    const o = src as Record<string, unknown>;
    if ("workflow" in o && (o.workflow === null || o.workflow === undefined)) continue;
    const wf = workflowObj(o);
    const id = str(o.session_id) ?? str(o.lead_session_id) ?? str(o.leadSessionId)
      ?? (wf ? str(wf.lead_session_id) ?? str(wf.leadSessionId) ?? str(wf.session_id) : undefined);
    if (id) return id;
  }
  return undefined;
}

/** owner/name only. A local path must never go to readPrFacts.repo. */
export function isGhRepo(s: unknown): s is string {
  return typeof s === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s);
}

export function ghRepoOf(state: GraphRunState): string | undefined {
  if (isGhRepo(state.gh_repo)) return state.gh_repo;
  if (isGhRepo(state.pr_binding?.repo)) return state.pr_binding!.repo;
  if (isGhRepo(state.repo)) return state.repo;
  return undefined;
}

type ContentFp = { head: string; status_digest: string; content_hash: string };

/** Git failure is "fingerprint unknown", never a synthetic hash and never a pass. */
async function readContentFingerprint(ctx: ToolContext, repoDir: string): Promise<ContentFp | null> {
  if (!repoDir) return null;
  try {
    const fp = await node<ContentFp>(ctx, "git/content-fingerprint", { repo_dir: repoDir });
    if (!fp?.head || !fp.status_digest || !fp.content_hash) return null;
    return fp;
  } catch {
    return null;
  }
}

function completeStartState(s: GraphRunState["start_state"]): ContentFp | null {
  if (!s?.head || !s.status_digest || !s.content_hash) return null;
  return { head: s.head, status_digest: s.status_digest, content_hash: s.content_hash };
}

function ranWithTestsPassed(ran: unknown): NodeReport["ran"] {
  if (!Array.isArray(ran)) return [];
  return ran.flatMap((x) => {
    if (!x || typeof x !== "object") return [];
    const o = x as { cmd?: unknown; exit_code?: unknown; tests_passed?: unknown };
    if (typeof o.cmd !== "string" || typeof o.exit_code !== "number") return [];
    return [{
      cmd: o.cmd,
      exit_code: o.exit_code,
      ...(Number.isInteger(o.tests_passed) && (o.tests_passed as number) >= 0 ? { tests_passed: o.tests_passed as number } : {}),
    }];
  });
}

/** Copy worker fields only. Do not invent surface or ui_evidence. tests_passed stays on ran[]. */
export function verdictReportFromNode(report: NodeReport): VerdictReport {
  return {
    dispatch_key: report.dispatch_key,
    status: report.status,
    summary: report.summary,
    ...(report.verdict ? { verdict: report.verdict } : {}),
    ran: ranWithTestsPassed(report.ran),
    ...(report.findings ? { findings: report.findings } : {}),
    ...(report.surface ? { surface: report.surface } : {}),
    ...(report.ui_evidence ? { ui_evidence: report.ui_evidence } : {}),
  };
}

async function materializeRun(
  ctx: ToolContext,
  runId: string,
  profile: Profile,
  pending: RoutePending,
  taskType: GraphTaskType,
): Promise<{ next: Next; state: GraphRunState }> {
  const spec = PSTACK_GRAPHS[taskType];
  // Real run ⑪: a writing run with no scope only failed later, at each writing node's report.
  if (!pending.scope?.length && spec.nodes.some((n) => n.writes)) {
    throw new KeelError("SCOPE_REQUIRED", `${taskType} 运行有写代码节点，keel_run 需要 scope（可写文件或 glob 列表，如 ["src/x.js","tests/**"]）。`, { field: "scope" });
  }
  const cfg = await loadRuntimeConfig(ctx.host);
  let worktree: string | undefined;
  let start_state: { head?: string; status_digest?: string; content_hash?: string } | undefined;
  let repo_root: string | undefined;
  let gh_repo: string | undefined;
  try {
    const st = await node<{ root?: string; branch?: string; head?: string; gh_repo?: string }>(ctx, "git/state", { repo_dir: pending.repo_dir });
    repo_root = st.root;
    if (isGhRepo(st.gh_repo)) gh_repo = st.gh_repo;
    if (taskType === "investigation") {
      const fp = await readContentFingerprint(ctx, pending.repo_dir);
      if (!fp) throw new KeelError("FINGERPRINT_UNKNOWN", "起始指纹未知，调查未完成。");
      start_state = fp;
    } else if (taskType === "pr") {
      const branch = pending.branch ?? st.branch;
      if (!branch || branch === "HEAD") throw new KeelError("WORKTREE_FAILED", "pr 类型需要已有功能分支。");
      const wt = await node<{ path?: string; occupied?: string; branch?: string }>(ctx, "worktree/create", {
        repo_dir: pending.repo_dir, name: `keel-${runId}`, existing: true, branch,
      });
      if (wt.occupied) {
        return { next: { kind: "stop", reason: `分支 ${wt.branch ?? branch} 已在 ${wt.occupied} 检出。`, needs_user: ["释放占用的工作树，或指定空闲 worktree"] }, state: { run_id: runId } as GraphRunState };
      }
      worktree = wt.path;
    } else {
      const wt = await node<{ path?: string }>(ctx, "worktree/create", { repo_dir: pending.repo_dir, name: `keel-${runId}` });
      worktree = wt.path;
    }
  } catch (e) {
    if (e instanceof KeelError) throw e;
    throw new KeelError("WORKTREE_FAILED", e instanceof Error ? e.message : String(e));
  }
  await createRun(ctx.host, {
    run_id: runId,
    spec_id: spec.id,
    profile_id: profile.id,
    lead_harness: profile.harness,
    task_type: taskType,
    entry: spec.entry,
    goal: pending.goal,
    sc: pending.sc,
    invocation_dir: pending.repo_dir,
    repo_root,
    gh_repo,
    repo: gh_repo,
    worktree,
    pr: pending.pr,
    ...(pending.pr !== undefined ? { pr_explicit: true } : {}),
    start_state,
    astra_budget: cfg.limits.astraBudget,
    now: ctx.host.now(),
    ...(pending.scope ? { scopeAllow: pending.scope } : {}),
  });
  await ctx.host.fs({ op: "delete", root: "data", path: routePendingPath(runId) });
  return step(ctx, runId, { type: "tick" });
}

async function startEntryAstraConsult(
  ctx: ToolContext,
  runId: string,
  profile: Profile,
  pending: RoutePending,
  astra: { options: string[]; question: string; jev?: unknown },
): Promise<{ next: Next; state: GraphRunState }> {
  const cfg = await loadRuntimeConfig(ctx.host);
  await ctx.host.fs({ op: "write", root: "data", path: routePendingPath(runId), content: JSON.stringify(pending) });
  if ((cfg.limits.astraBudget ?? 0) <= 0) {
    const next: Next = {
      kind: "decide",
      gate_id: "human:astra-budget",
      question: "Astra 预算用完，改为人工裁决",
      options: ["retry", "stop"],
      context: { routed: "astra", jev: astra.jev },
    };
    await ctx.host.fs({
      op: "write",
      root: "data",
      path: `runs/${runId}/graph-state.json`,
      content: JSON.stringify({ run_id: runId, profile_id: profile.id, goal: pending.goal, status: "waiting_human", next }),
    });
    return { next, state: { run_id: runId } as GraphRunState };
  }
  const spec = PSTACK_GRAPHS["bug-fix"];
  await createRun(ctx.host, {
    run_id: runId,
    spec_id: spec.id,
    profile_id: profile.id,
    lead_harness: profile.harness,
    task_type: "bug-fix",
    entry: ASTRA_CONSULT_ID,
    goal: pending.goal,
    sc: pending.sc,
    invocation_dir: pending.repo_dir,
    astra_budget: cfg.limits.astraBudget,
    now: ctx.host.now(),
    ...(pending.scope ? { scopeAllow: pending.scope } : {}),
  });
  await withRun(ctx.host, runId, (raw) => {
    const s = raw as unknown as GraphRunState;
    s.pending_astra_gate = { gate_id: "G-route", options: astra.options, question: astra.question };
    s.consult_node = { id: ASTRA_CONSULT_ID, kind: "dispatch", role: "architect", writes: false, playbook_steps: [], timebox_min: 40, max_attempts: 2 };
  });
  return step(ctx, runId, { type: "tick" });
}

function pickProfile(manual: ModelManual, args: Record<string, unknown>): { profile?: Profile; decide?: Next } {
  const named = str(args.profile);
  if (named) return { profile: findProfile(manual, named) };
  const lead = str(args.lead);
  if (!lead || !LEADS.has(lead as Harness)) throw new KeelError("INVALID_INPUT", "keel_run 需要 lead: codex | claude-code | pi。");
  try {
    return { profile: resolveProfileForHarness(manual, lead as Harness) };
  } catch (e) {
    if (e instanceof KeelError && (e.code === "PROFILE_HARNESS_DEFAULT_MISSING" || e.code === "PROFILE_UNKNOWN")) {
      return {
        decide: {
          kind: "decide",
          gate_id: "profile",
          question: "选择主控方案",
          options: manual.profiles.map((p) => p.id),
          context: { lead },
        },
      };
    }
    throw e;
  }
}

function consumeGateAnswer(state: GraphRunState, gateId: string): string | undefined {
  const attempt = state.nodes[gateId]?.attempts ?? 0;
  const i = state.sol_decisions.findIndex((d) => d.gate_id === gateId && d.attempt === attempt);
  if (i < 0) return undefined;
  const answer = state.sol_decisions[i]!.answer;
  state.sol_decisions.splice(i, 1);
  return answer;
}

function predecessorOfGate(state: GraphRunState, gateId: string): { nodeId: string; report?: NodeReportSnap } | undefined {
  const spec = PSTACK_GRAPHS[state.spec_id as GraphTaskType];
  const froms = spec?.edges.filter((e) => e.to === gateId).map((e) => e.from) ?? [];
  for (const id of froms) {
    const n = state.nodes[id];
    if (n?.last_report) return { nodeId: id, report: n.last_report };
  }
  if (froms[0]) return { nodeId: froms[0], report: state.nodes[froms[0]]?.last_report };
  return undefined;
}

function evidenceForGate(state: GraphRunState, gateId: string): Evidence {
  const prev = predecessorOfGate(state, gateId);
  if (!prev) return { evidence_present: false, new_evidence: false };
  const report = prev.report;
  const ev = advanceEvidenceForNode({
    nodeId: prev.nodeId,
    ran: report?.ran,
    ...(typeof report?.head_matches === "boolean" ? { head_matches: report.head_matches } : {}),
    new_report: report?.fresh === true,
    new_commit: (report?.files_changed?.length ?? 0) > 0,
  });
  if (report?.fresh) report.fresh = false;
  return ev;
}

function stateGateStore(state: GraphRunState): GateStore {
  if (!state.gate_cache) state.gate_cache = {};
  const cache = state.gate_cache;
  const key = (gateId: string, sha: string) => `${gateId}:${sha}`;
  return {
    get: async (_run, gateId, sha) => (cache[key(gateId, sha)] as GateDecision | undefined) ?? null,
    set: async (_run, gateId, sha, decision) => {
      cache[key(gateId, sha)] = decision;
    },
  };
}

function gateIdOf(nodeId: string): GateId {
  if (nodeId.startsWith("g-retry")) return "G-retry";
  if (nodeId.startsWith("g-accept")) return "G-accept";
  if (nodeId.includes("arena")) return "G-arena";
  return "G-advance";
}

function makeGates(ctx: ToolContext, runId: string, graph: GraphKind, direction_gate: "lead" | "astra"): GateHooks {
  const decide = async (nodeId: string, state: GraphRunState, extra: Evidence = {}): Promise<string | undefined> => {
    const human = consumeGateAnswer(state, nodeId);
    if (human) return human;
    const evidence = { ...evidenceForGate(state, nodeId), ...extra };
    const decision = await runGate(ctx, gateIdOf(nodeId), evidence, {
      run_id: runId,
      store: stateGateStore(state),
      graph,
      direction_gate,
    });
    if (decision.routed === "astra") {
      const def = GATES[gateIdOf(nodeId)];
      state.pending_astra_gate = {
        gate_id: nodeId,
        options: [...def.options(evidence)],
        question: def.question(evidence).instructions,
      };
      return undefined;
    }
    if (decision.routed === "lead") return undefined;
    return decision.value;
  };
  return {
    retry: async (input) => {
      const v = await decide(input.node, input.state, { consecutive_failures: input.consecutive_failures, error_mode: input.error_mode });
      if (v === "retry" || v === "escalate" || v === "stop" || v === "human") return v;
      return classifyRetry(input.error_mode as ErrorMode | undefined, input.consecutive_failures).decision;
    },
    advance: async ({ node, state }) => {
      const v = await decide(node, state);
      return v === "advance" || v === "stay" ? v : undefined;
    },
    accept: async ({ node, state }) => {
      const v = await decide(node, state);
      return v === "adopt" || v === "revise" || v === "ask_user" ? v : undefined;
    },
    arena: async ({ node, state }) => {
      const v = await decide(node, state);
      return v === "single" || v === "arena" ? v : undefined;
    },
  };
}

export function authorFamiliesFromRoutes(state: GraphRunState): string[] {
  const out: string[] = [];
  for (const n of Object.values(state.nodes)) {
    if (n.planned_params?.writes !== true) continue;
    const model = n.actual_route?.model;
    if (!model) continue;
    const fam = family(model);
    if (fam && !out.includes(fam)) out.push(fam);
  }
  return out;
}

export function asGraphVerdict(state: GraphRunState): GraphVerdict | null {
  const v = state.verdict;
  if (!v?.patch_id || !v.base_sha || !(v.head || "") || !v.by_route?.model) return null;
  const level = v.level;
  if (level !== "live-ui-verified" && level !== "unit-test-verified" && level !== "type-check-only" && level !== "verifier-blocked" && level !== "verifier-failed") return null;
  return {
    repo: ghRepoOf(state) ?? "",
    pr: state.pr ?? 0,
    base_ref: v.base_ref ?? "",
    base_sha: v.base_sha,
    head_sha: v.head ?? "",
    patch_id: v.patch_id,
    level,
    surface: (v.surface as GraphVerdict["surface"]) ?? "type-check",
    by_route: v.by_route,
    by_family: v.by_family ?? "",
  };
}

export function mapChangeDoneFailure(state: GraphRunState, result: ChangeGraphDoneResult): Next {
  if (result.next === "verify-head") {
    const id = rewindVerifier(state);
    return { kind: "decide", gate_id: `human:${id}`, question: `验证未通过：${result.missing.join("；")}`, options: ["retry_verify", "stop"], context: { missing: result.missing, next: "verify-head" } };
  }
  if (result.next === "recheck-ci") {
    const wait = PSTACK_GRAPHS[state.spec_id as GraphTaskType]?.nodes.find((n) => n.id === "wait-ci" || n.id === "ci-rerun-once");
    if (wait) state.cursor = wait.id;
    return { kind: "wait", call: { tool: "keel_wait", args: { run_id: state.run_id, max_minutes: 15 } } };
  }
  if (result.missing.length === 1 && /pr_status 是 handoff/.test(result.missing[0]!)) {
    return {
      kind: "wait",
      call: {
        tool: "pr_ready",
        args: {
          run_id: state.run_id,
          ...(ghRepoOf(state) ? { repo: ghRepoOf(state) } : {}),
          ...(state.pr != null ? { pr: state.pr } : {}),
          ...(state.worktree ? { repo_dir: state.worktree } : {}),
          authorization_source: "",
          review_entry: {
            head_sha: state.verdict?.head ?? "",
            checked_at: "",
            result: "",
            source: "",
          },
        },
      },
      note: "交接车道的 done 门是 handoff，需要 pr_ready 收口，handoff 本身不算完成。authorization_source 必须是用户对「转 Ready / 交接」的实际授权原话；review_entry 必须在核实审查机进场条件后按真实结果填写。拿不到这两项时停下来问用户，不能自己编。",
    };
  }
  return { kind: "decide", gate_id: "done", question: `尚未完成：${result.missing.join("；")}`, options: ["wait", "stop"], context: { missing: result.missing } };
}

function rewindVerifier(state: GraphRunState): string {
  const spec = PSTACK_GRAPHS[state.spec_id as GraphTaskType];
  const id = spec?.nodes.find((n) => n.role === "verifier")?.id
    ?? Object.entries(state.nodes).find(([, n]) => n.planned_params?.role === "keel-verifier")?.[0]
    ?? "verify-same-surface";
  const node = ensureNode(state, id);
  node.attempts += 1;
  node.status = "pending";
  node.dispatch_state = undefined;
  node.dispatch_key = undefined;
  state.cursor = id;
  return id;
}

function openHumanGates(state: GraphRunState): number {
  if (state.status === "waiting_human") return 1;
  return Object.values(state.nodes).filter((n) => n.status === "active" && n.planned_params?.role === undefined).length ? 0 : 0;
}

function asScMinLevel(v: unknown): SuccessCriterion["min_level"] {
  if (v === "live-ui-verified" || v === "unit-test-verified" || v === "type-check-only") return v;
  return undefined;
}

/** Loose SC.verify surface: any independent playwright/cypress token tightens the requirement. */
export function scVerifyImpliesLiveUi(verify: string): boolean {
  return /(^|[^A-Za-z0-9_])(playwright|cypress)([^A-Za-z0-9_]|$)/i.test(verify);
}

export function normalizeSc(raw: unknown): SuccessCriterion[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new KeelError("INVALID_SC", "sc 必须是数组。", { field: "sc" });
  return raw.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new KeelError("INVALID_SC", `sc[${i}] 不是对象。`, { index: i, missing: ["object"] });
    }
    const o = item as Record<string, unknown>;
    const missing: string[] = [];
    if (typeof o.id !== "string" || !o.id.trim()) missing.push("id");
    if (typeof o.text !== "string" || !o.text.trim()) missing.push("text");
    const hasMin = Object.prototype.hasOwnProperty.call(o, "min_level") || Object.prototype.hasOwnProperty.call(o, "minLevel");
    const named = asScMinLevel(o.min_level) ?? asScMinLevel(o.minLevel);
    if (hasMin && !named) missing.push("min_level");
    if (missing.length) throw new KeelError("INVALID_SC", `sc[${i}] 缺少或非法：${missing.join("、")}`, { index: i, missing });
    const verify = typeof o.verify === "string" ? o.verify : undefined;
    const inferred = !named && verify && scVerifyImpliesLiveUi(verify) ? "live-ui-verified" as const : undefined;
    return {
      id: o.id as string,
      text: o.text as string,
      ...(verify ? { verify } : {}),
      ...(named ?? inferred ? { min_level: named ?? inferred } : {}),
    };
  });
}

function scRows(state: GraphRunState): ScRow[] {
  const evidence: Record<string, boolean> = {};
  for (const n of Object.values(state.nodes)) Object.assign(evidence, n.last_report?.sc_evidence ?? {});
  return (state.sc ?? []).map((s) => ({
    id: s.id,
    hasEvidence: evidence[s.id] === true,
    ...(s.min_level ? { minLevel: s.min_level } : {}),
  }));
}

function lastCitation(state: GraphRunState): string | undefined {
  let best: { at: number; citation?: string } | undefined;
  for (const n of Object.values(state.nodes)) {
    if (!n.last_report) continue;
    const at = n.ended_at ?? 0;
    if (!best || at >= best.at) best = { at, citation: n.last_report.citation };
  }
  return best?.citation;
}

export function waitOnFromFacts(facts: PrFacts): Extract<AdvanceEvent, { type: "wait_done" }> ["on"] | "wait" {
  const a = facts.nextAction;
  if (a === "wait_for_ci" || a === "wait_for_review") return "wait";
  if (a === "classify_ci_failure") return "ci_red";
  if (a === "report_conflict_rebase_needed") return "conflict";
  if (a === "triage_review_threads") return "threads";
  if (a === "verify_current_head") return "head_moved";
  return "ok";
}

export async function runDoneCheck(ctx: ToolContext, state: GraphRunState): Promise<DoneCheckResult> {
  if (state.task_type === "investigation") {
    const start = completeStartState(state.start_state);
    const current = await readContentFingerprint(ctx, state.invocation_dir ?? "");
    if (!start || !current) {
      return { ok: false, next: { kind: "decide", gate_id: "done", question: "内容指纹未知，调查未完成。", options: ["retry", "stop"], context: { missing: ["指纹未知"] } } };
    }
    const citation = lastCitation(state);
    const evalDone = isInvestigationDone({
      reportComplete: Object.values(state.nodes).some((n) => n.last_report && (n.last_report.status === "done" || n.last_report.status === "partial")),
      reportCitation: citation,
      sc: scRows(state),
      openHumanGates: state.status === "waiting_human" ? 1 : 0,
      start,
      current,
    });
    if (evalDone.done) return { ok: true, summary: "调查完成" };
    return { ok: false, next: { kind: "decide", gate_id: "done", question: `调查未完成：${evalDone.missing.join("；")}`, options: ["retry", "stop"], context: { missing: evalDone.missing } } };
  }
  if (!CHANGE_TYPES.has(state.task_type)) return { ok: true };
  let facts: PrFacts | undefined;
  try {
    if (state.pr != null) {
      const gh = ghRepoOf(state);
      facts = await readPrFacts(ctx, { ...(gh ? { repo: gh } : {}), pr: state.pr, repo_dir: state.worktree });
    }
  } catch {
    facts = undefined;
  }
  const git = state.worktree ? await node<{ head?: string }>(ctx, "git/state", { repo_dir: state.worktree }).catch(() => ({ head: undefined })) : { head: undefined };
  // The PR head is what would be merged; a verified local commit that is not pushed does not count.
  const prHead = facts?.snapshot.pr.headSha ?? undefined;
  if (state.pr != null && (!prHead || (git.head && git.head !== prHead))) {
    const missing = !prHead ? ["读不到 PR 当前 head"] : [`本地 head ${git.head!.slice(0, 7)} 与 PR head ${prHead.slice(0, 7)} 不一致（未推送或已被他人更新）`];
    return { ok: false, next: { kind: "decide", gate_id: "done", question: `尚未完成：${missing.join("；")}`, options: ["wait", "stop"], context: { missing } } };
  }
  const head = prHead ?? git.head ?? "";
  const baseRef = facts?.snapshot.pr.baseRef;
  const computed = state.worktree && baseRef
    ? await node<{ base_sha?: string }>(ctx, "git/base-sha", { repo_dir: state.worktree, base_ref: baseRef }).catch(() => ({ base_sha: undefined as string | undefined }))
    : { base_sha: undefined as string | undefined };
  const base = computed.base_sha ?? "";
  let patch: { patch_id: string | null; patch_ok: boolean } = { patch_id: null, patch_ok: false };
  if (state.worktree && base && head) {
    const pid = await node<{ ok?: boolean; patch_id?: string }>(ctx, "git/patch-id", { repo_dir: state.worktree, base_sha: base, head_sha: head }).catch(() => ({ ok: false, patch_id: undefined }));
    patch = { patch_id: pid.ok && pid.patch_id ? pid.patch_id : null, patch_ok: Boolean(pid.ok && pid.patch_id) };
  }
  const input: ChangeGraphDoneInput = {
    pr_status: facts?.nextAction ?? "wait_for_ci",
    author_families: authorFamiliesFromRoutes(state),
    verdict: asGraphVerdict(state),
    current: { head_sha: head, base_sha: base, patch_id: patch.patch_id, patch_ok: patch.patch_ok },
    sc: scRows(state),
    openHumanGates: openHumanGates(state),
  };
  const result = isChangeGraphDone(input);
  const ledger = await confirmLedgerHead(ctx, state, head);
  const missing = [...result.missing, ...ledger.missing];
  if (missing.length === 0) return { ok: true, summary: "变更图完成" };
  return { ok: false, next: mapChangeDoneFailure(state, { done: false, missing, next: result.next ?? "wait" }) };
}

async function persistSideEffects(host: Host, state: GraphRunState): Promise<void> {
  const runs = await loadGraphStates(host);
  const entries = runs.map((r) => {
    const s = r as unknown as GraphRunState;
    return {
      workdir: String(s.worktree || s.invocation_dir || s.repo_root || ""),
      run_id: String(s.run_id || ""),
      status: String(s.status || ""),
      current_node: String(s.cursor || ""),
      updated_at: new Date(s.updated_at || host.now()).toISOString(),
    };
  });
  await writeActiveIndex(host, toActiveIndex(entries.filter((e) => e.workdir && e.run_id)));
  host.broadcast({ type: "graph-delta", run_id: state.run_id, status: state.status, next: state.next, cursor: state.cursor, at: new Date(host.now()).toISOString() });
  if (state.verdict) {
    await writeRunArtifact(host, state.run_id, "verdict.json", JSON.stringify(state.verdict));
  }
  for (const [id, node] of Object.entries(state.nodes)) {
    if (!node.last_report) continue;
    await writeRunArtifact(host, state.run_id, `nodes/${id}.json`, JSON.stringify(node.last_report));
  }
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

function pickStrId(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === "string" && v) return v;
  return undefined;
}

function pickRevision(v: unknown): number | undefined {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
}

function pluginReceipt(data: unknown): { task_id?: string; revision?: number; task_run_id?: string } {
  const o = rec(data);
  const task_id = pickStrId(o.task_id, o.taskId);
  const task_run_id = pickStrId(o.task_run_id, o.taskRunId, o.run_id, o.runId);
  const revision = pickRevision(o.revision);
  return {
    ...(task_id ? { task_id } : {}),
    ...(revision !== undefined ? { revision } : {}),
    ...(task_run_id ? { task_run_id } : {}),
  };
}

function reportJsonPayload(text: string): string | undefined {
  const fence = text.match(/```json\s*([\s\S]*?)```/);
  if (fence?.[1]) return fence[1];
  const trimmed = text.trim();
  return trimmed.startsWith("{") ? trimmed : undefined;
}

function isKeelNodeReport(raw: unknown, expectedKey: string): raw is Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const o = raw as Record<string, unknown>;
  if (typeof o.dispatch_key !== "string" || o.dispatch_key !== expectedKey) return false;
  if (typeof o.status !== "string" || !(NODE_REPORT_STATUSES as readonly string[]).includes(o.status)) return false;
  if (typeof o.summary !== "string") return false;
  return true;
}

function reportFromMessages(data: unknown, expectedKey: string): { report?: Record<string, unknown>; unconfirmed: boolean } {
  const o = rec(data);
  const msgs = Array.isArray(o.messages) ? o.messages : Array.isArray(o.items) ? o.items : [];
  if (!msgs.length) return { unconfirmed: true };
  const last = rec(msgs[msgs.length - 1]);
  if (pickStrId(last.role) !== "assistant") return { unconfirmed: true };
  const text = pickStrId(last.text, last.content, last.body);
  if (!text) return { unconfirmed: true };
  const payload = reportJsonPayload(text);
  if (!payload) return { unconfirmed: true };
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (isKeelNodeReport(parsed, expectedKey)) return { report: parsed, unconfirmed: false };
  } catch { /* truncated or invalid JSON */ }
  return { unconfirmed: true };
}

async function findTaskByRequestKey(api: NonNullable<Host["tasks"]>, requestKey: string | undefined): Promise<{ task_id?: string; revision?: number } | undefined> {
  if (!requestKey || typeof api.list !== "function") return undefined;
  const invoked = await invokeCindyTasks(api, { phase: "list" });
  if (!invoked.ok) return undefined;
  const items = rec(invoked.data).items;
  if (!Array.isArray(items)) return undefined;
  for (const it of items) {
    const row = rec(it);
    if (pickStrId(row.requestKey, row.request_key) === requestKey) {
      return { task_id: pickStrId(row.taskId, row.task_id), revision: pickRevision(row.revision) };
    }
  }
  return undefined;
}

async function drainPluginOps(ctx: ToolContext, runId: string, out: AdvanceResult, opts: AdvanceOpts): Promise<AdvanceResult> {
  const api = ctx.host.tasks;
  if (!api) return out;
  let current = out;
  for (let i = 0; i < 8; i++) {
    const n = current.next;
    if (n.kind === "dispatch" && n.plugin_task) {
      const input: PluginTaskInput = {
        phase: n.plugin_task.phase,
        request_key: n.plugin_task.request_key,
        body: n.plugin_task.body,
        task_id: n.plugin_task.task_id,
        expected_revision: n.plugin_task.expected_revision,
        text: n.plugin_task.text,
      };
      const invoked = await invokeCindyTasks(api, input);
      const receipt = invoked.ok ? pluginReceipt(invoked.data) : {};
      current = await advance(ctx.host, runId, {
        type: "report",
        phase: "accepted",
        dispatch_key: n.dispatch_key,
        ...receipt,
      }, opts);
      continue;
    }
    if (n.kind === "reconcile" && n.queries.every((q) => q.tool === "getRun" || q.tool === "readMessages")) {
      const node = Object.values(current.state.nodes).find((x) => x.dispatch_key === n.dispatch_key);
      const queries_result: ReconcileQueries = {};
      if (node?.task?.phase === "create" || !n.queries.some((q) => q.tool === "getRun" && q.run_id)) {
        const found = await findTaskByRequestKey(api, node?.task?.create_request_key);
        queries_result.getRun = found?.task_id
          ? { ok: true, complete: true, task_id: found.task_id, ...(found.revision !== undefined ? { revision: found.revision } : {}) }
          : { ok: true, complete: true, errorCode: "TASK_NOT_FOUND" };
      } else {
        for (const q of n.queries) {
          if (q.tool === "getRun" && q.run_id) {
            const invoked = await invokeCindyTasks(api, { phase: "getRun", task_run_id: q.run_id });
            const data = invoked.ok ? rec(invoked.data) : {};
            const receipt = pluginReceipt(data);
            queries_result.getRun = {
              ok: invoked.ok,
              complete: invoked.ok,
              ...(receipt.task_run_id ? { run_id: receipt.task_run_id } : {}),
              ...(receipt.task_id ? { task_id: receipt.task_id } : {}),
              ...(receipt.revision !== undefined ? { revision: receipt.revision } : {}),
              ...(typeof data.status === "string" ? { status: data.status } : {}),
              ...(!invoked.ok ? { errorCode: invoked.errorCode } : {}),
            };
          }
          if (q.tool === "readMessages") {
            const invoked = q.task_id ? await collectTaskMessages(api, q.task_id) : await invokeCindyTasks(api, { phase: "readMessages", task_id: q.task_id });
            queries_result.readMessages = { ok: invoked.ok, complete: invoked.ok, ...(!invoked.ok ? { errorCode: invoked.errorCode } : {}) };
          }
        }
      }
      current = await advance(ctx.host, runId, {
        type: "report",
        phase: "reconcile",
        dispatch_key: n.dispatch_key,
        queries_result,
      }, opts);
      continue;
    }
    break;
  }
  return current;
}

async function step(ctx: ToolContext, runId: string, event: AdvanceEvent): Promise<{ next: Next; state: GraphRunState }> {
  const cfg = await loadRuntimeConfig(ctx.host);
  const states = await loadGraphStates(ctx.host);
  const st = states.find((r) => (r as { run_id?: string }).run_id === runId) as GraphRunState | undefined;
  let profile;
  try { profile = st?.profile_id ? findProfile(cfg.manual, st.profile_id) : undefined; } catch { profile = undefined; }
  const graph = (st?.task_type ?? "bug-fix") as GraphKind;
  const opts: AdvanceOpts = {
    gates: makeGates(ctx, runId, graph, profile?.direction_gate === "astra" ? "astra" : "lead"),
    doneCheck: (state) => runDoneCheck(ctx, state),
    ...(ctx.sessionId ? { leadSessionId: ctx.sessionId } : {}),
  };
  let out = await advance(ctx.host, runId, event, opts);
  out = await drainPluginOps(ctx, runId, out, opts);
  await persistSideEffects(ctx.host, out.state);
  return out;
}

function pack(runId: string, profile: Profile | undefined, next: Next, extra: Record<string, unknown> = {}) {
  return {
    run_id: runId,
    next,
    ...(profile ? { profile: { id: profile.id, name: profile.name } } : {}),
    ...extra,
  };
}

export async function keelRun(ctx: ToolContext, args: Record<string, unknown>) {
  const goal = requireString(args, "goal");
  const repoDir = requireString(args, "repo_dir");
  const cfg = await loadRuntimeConfig(ctx.host);
  const picked = pickProfile(cfg.manual, args);
  const runId = newRunId(ctx.host.now());
  const pr = typeof args.pr === "number" || typeof args.pr === "string" ? args.pr : undefined;
  const sc = normalizeSc(args.sc);
  const scopeAllow = Array.isArray(args.scope) && args.scope.every((x) => typeof x === "string") ? (args.scope as string[]) : undefined;
  const pendingBase = (): RoutePending => ({
    goal,
    repo_dir: repoDir,
    profile_id: picked.profile?.id ?? "",
    sc,
    ...(str(args.lead) ? { lead: str(args.lead) } : {}),
    ...(str(args.playbook) ? { playbook: str(args.playbook) } : {}),
    ...(scopeAllow ? { scope: scopeAllow } : {}),
    ...(pr !== undefined ? { pr } : {}),
    ...(str(args.branch) ? { branch: str(args.branch) } : {}),
  });
  if (!picked.profile) {
    const pending = pendingBase();
    await ctx.host.fs({ op: "write", root: "data", path: routePendingPath(runId), content: JSON.stringify(pending) });
    await ctx.host.fs({
      op: "write",
      root: "data",
      path: `runs/${runId}/graph-state.json`,
      content: JSON.stringify({ run_id: runId, goal, status: "await_sol", next: picked.decide }),
    });
    return pack(runId, undefined, picked.decide!);
  }
  const routed = await resolveGraphTask(ctx, {
    goal,
    playbook: str(args.playbook),
    ...(pr !== undefined ? { pr } : {}),
    run_id: runId,
    profile: picked.profile,
  });
  if ("decide" in routed) {
    const pending: RoutePending = {
      ...pendingBase(),
      profile_id: picked.profile.id,
    };
    await ctx.host.fs({ op: "write", root: "data", path: routePendingPath(runId), content: JSON.stringify(pending) });
    await ctx.host.fs({
      op: "write",
      root: "data",
      path: `runs/${runId}/graph-state.json`,
      content: JSON.stringify({
        run_id: runId,
        profile_id: picked.profile.id,
        goal,
        status: "await_sol",
        next: routed.decide,
      }),
    });
    return pack(runId, picked.profile, routed.decide);
  }
  if ("astra" in routed) {
    const pending: RoutePending = { ...pendingBase(), profile_id: picked.profile.id };
    const out = await startEntryAstraConsult(ctx, runId, picked.profile, pending, routed.astra);
    return pack(runId, picked.profile, out.next);
  }
  const out = await materializeRun(ctx, runId, picked.profile, {
    goal,
    repo_dir: repoDir,
    profile_id: picked.profile.id,
    sc,
    ...(scopeAllow ? { scope: scopeAllow } : {}),
    ...(pr !== undefined ? { pr } : {}),
    ...(str(args.branch) ? { branch: str(args.branch) } : {}),
  }, routed.taskType);
  return pack(runId, picked.profile, out.next, { spec_id: PSTACK_GRAPHS[routed.taskType].id, worktree: out.state.worktree });
}

/** Worker sessions of this run must not drive it (real run: an explorer worker called keel_report itself). */
async function assertNotRunWorker(ctx: ToolContext, runId: string): Promise<void> {
  if (!ctx.sessionId) return;
  const states = await loadGraphStates(ctx.host);
  const st = states.find((r) => (r as { run_id?: string }).run_id === runId) as GraphRunState | undefined;
  const worker = Object.entries(st?.nodes ?? {}).find(([, n]) => n.worker_session_id === ctx.sessionId);
  if (worker) {
    throw new KeelError("NOT_LEAD", `这是节点 ${worker[0]} 的 worker 会话，不能推进 run ${runId}。worker 只写报告并回复主控；keel_report / keel_wait / keel_gate 由主控调用。`);
  }
}

export async function keelReport(ctx: ToolContext, args: Record<string, unknown>) {
  const runId = requireString(args, "run_id");
  await assertNotRunWorker(ctx, runId);
  const phase = requireString(args, "phase");
  if (!["setup", "accepted", "reconcile", "recover", "final"].includes(phase)) {
    throw new KeelError("INVALID_INPUT", "phase 须为 setup | accepted | reconcile | recover | final。");
  }
  const base: Extract<AdvanceEvent, { type: "report" }> = { type: "report", phase: phase as Extract<AdvanceEvent, { type: "report" }> ["phase"] };
  if (phase === "setup") {
    const outcome = args.outcome && typeof args.outcome === "object" ? { ...(args.outcome as Record<string, unknown>) } : { ...args };
    const team_id = resolveTeamId(outcome, args, args.workspace_info, args.get_workspace_info);
    const session = resolveLeadSessionId(args, outcome, args.workspace_info, args.get_workspace_info);
    if (team_id) outcome.team_id = team_id;
    if (session) base.session_id = session;
    base.outcome = outcome;
  }
  if (phase === "accepted") {
    const mapped = mapCreateWorkerReceipt(args);
    Object.assign(base, mapped);
    if (typeof args.dispatch_key === "string") base.dispatch_key = args.dispatch_key;
    const task_id = str(args.task_id);
    const revision = pickRevision(args.revision);
    const task_run_id = str(args.task_run_id);
    if (task_id) base.task_id = task_id;
    if (revision !== undefined) base.revision = revision;
    if (task_run_id) base.task_run_id = task_run_id;
  }
  if (phase === "reconcile") {
    const raw = args.queries_result && typeof args.queries_result === "object" ? args.queries_result as Record<string, unknown> : args;
    base.queries_result = {
      ...(raw.list_workers !== undefined ? { list_workers: normalizeListWorkers(raw.list_workers) } : {}),
      ...(raw.get_worker_queue_status && typeof raw.get_worker_queue_status === "object" ? { get_worker_queue_status: raw.get_worker_queue_status as ReconcileQueries["get_worker_queue_status"] } : {}),
      ...(raw.getRun && typeof raw.getRun === "object" ? { getRun: raw.getRun as ReconcileQueries["getRun"] } : {}),
      ...(raw.readMessages && typeof raw.readMessages === "object" ? { readMessages: raw.readMessages as ReconcileQueries["readMessages"] } : {}),
    };
    if (typeof args.dispatch_key === "string") base.dispatch_key = args.dispatch_key;
    const wf = resolveTeamId(args.get_workspace_info, args.workspace_info);
    if (wf && base.queries_result?.list_workers) {
      base.queries_result.list_workers = { ...base.queries_result.list_workers, team_id: wf };
    }
  }
  if (phase === "recover") {
    if (typeof args.action === "string") base.action = args.action as "send_initial" | "diagnose" | "archive" | "verify_stopped";
    const ar = args.action_result && typeof args.action_result === "object" ? { ...(args.action_result as Record<string, unknown>) } : {};
    if (ar.list_workers !== undefined) {
      const list = normalizeListWorkers(ar.list_workers);
      ar.list_workers = list;
      if (list.workers) ar.workers = list.workers;
      if (ar.ok === undefined) ar.ok = list.ok;
      if (ar.complete === undefined && list.complete !== undefined) ar.complete = list.complete;
      const team_id = resolveTeamId(args.get_workspace_info, args.workspace_info) ?? list.team_id ?? resolveTeamId(ar, args);
      if (team_id) {
        ar.team_id = team_id;
        ar.list_workers = { ...list, team_id };
      }
    }
    if (ar.worker_status && typeof ar.worker_status === "object") {
      const ws = ar.worker_status as Record<string, unknown>;
      if (ar.ok === undefined && typeof ws.ok === "boolean") ar.ok = ws.ok;
      if (ar.complete === undefined && typeof ws.complete === "boolean") ar.complete = ws.complete;
      if (ar.status === undefined && typeof ws.status === "string") ar.status = ws.status;
    }
    if (Object.keys(ar).length) base.action_result = ar;
    if (typeof args.dispatch_key === "string") base.dispatch_key = args.dispatch_key;
  }
  let pendingSink: GraphVerdict | undefined;
  let finalKey: string | undefined;
  if (phase === "final") {
    const key = requireString(args, "dispatch_key");
    finalKey = key;
    base.dispatch_key = key;
    const parsedKey = parseDispatchKey(key);
    const states = await loadGraphStates(ctx.host);
    const st = states.find((r) => (r as { run_id?: string }).run_id === runId) as GraphRunState | undefined;
    const reportDir = st?.worktree ?? st?.invocation_dir;
    let parsed: NodeReport | undefined;
    const inline = args.inline_report && typeof args.inline_report === "object" ? args.inline_report as Record<string, unknown> : undefined;
    if (inline) {
      base.inline_report = { status: (typeof inline.status === "string" ? inline.status : "done") as "done" | "partial" | "blocked" | "failed", summary: typeof inline.summary === "string" ? inline.summary : undefined };
      parsed = {
        dispatch_key: key,
        status: (typeof inline.status === "string" ? inline.status : "done") as NodeReport["status"],
        summary: typeof inline.summary === "string" ? inline.summary : "",
        files_changed: Array.isArray(inline.files_changed) ? inline.files_changed.filter((x): x is string => typeof x === "string") : [],
        ...(Array.isArray(inline.functions_touched) ? { functions_touched: inline.functions_touched.filter((x): x is string => typeof x === "string") } : {}),
        ...(Number.isInteger(inline.changed_lines) && (inline.changed_lines as number) >= 0 ? { changed_lines: inline.changed_lines as number } : {}),
        ran: ranWithTestsPassed(inline.ran),
        ...(typeof inline.citation === "string" ? { citation: inline.citation } : {}),
        ...(inline.sc_evidence && typeof inline.sc_evidence === "object" ? { sc_evidence: inline.sc_evidence as Record<string, boolean> } : {}),
        ...(typeof inline.head_sha === "string" ? { head_sha: inline.head_sha } : {}),
        ...(typeof inline.verdict === "string" ? { verdict: inline.verdict as NodeReport["verdict"] } : {}),
        ...(Array.isArray(inline.ui_evidence) ? { ui_evidence: inline.ui_evidence.filter((x): x is string => typeof x === "string") } : {}),
        ...(inline.surface === "live-ui" || inline.surface === "unit-test" || inline.surface === "type-check" || inline.surface === "blocked" ? { surface: inline.surface } : {}),
      };
    } else {
      if (!reportDir || !parsedKey) throw new KeelError("REPORT_INVALID", "final 需要 worktree 或 invocation_dir，以及 dispatch_key。");
      const file = await node<{ path: string; content: string }>(ctx, "report/read", { worktree: reportDir, node: parsedKey.nodeId, attempt: parsedKey.attempt });
      parsed = parseNodeReport(file.content, key);
      base.report_path = file.path;
    }
    const nodeState = parsedKey ? st?.nodes?.[parsedKey.nodeId] : undefined;
    if (nodeState?.planned_params?.writes) {
      const allow = nodeState.planned_params.scopeAllow;
      if (!allow?.length) {
        await step(ctx, runId, { type: "scope_fail", dispatch_key: key });
        throw new KeelError("SCOPE_VIOLATION", "该节点 planned_params 没有写域，拒绝落盘。");
      }
      const changed = await node<{ files: string[] }>(ctx, "git/changed-files", {
        repo_dir: reportDir ?? st?.worktree ?? st?.invocation_dir ?? "",
        ...(nodeState.planned_params?.start_sha ? { base: nodeState.planned_params.start_sha } : {}),
      });
      // .keel/ holds KEEL's own node reports, not product changes.
      const scope = checkScope((changed.files ?? []).filter((f) => !f.replace(/^\.\//, "").startsWith(".keel/")), allow);
      if (!scope.ok) {
        await step(ctx, runId, { type: "scope_fail", dispatch_key: key });
        throw new KeelError("SCOPE_VIOLATION", `写域越界：${scope.violations.join("、")}`, { violations: scope.violations });
      }
    }
    if (parsed) {
      const gh = st ? ghRepoOf(st) : undefined;
      let facts: PrFacts | undefined;
      try {
        if (st?.pr != null) facts = await readPrFacts(ctx, { ...(gh ? { repo: gh } : {}), pr: st.pr, repo_dir: st.worktree });
      } catch { facts = undefined; }
      const prHead = facts?.snapshot.pr.headSha ?? undefined;
      const headMatches = Boolean(parsed.head_sha && prHead && parsed.head_sha === prHead);
      const snap: NodeReportSnap = {
        status: parsed.status,
        summary: parsed.summary,
        ran: parsed.ran,
        files_changed: parsed.files_changed,
        ...(parsed.functions_touched ? { functions_touched: parsed.functions_touched } : {}),
        ...(parsed.changed_lines !== undefined ? { changed_lines: parsed.changed_lines } : {}),
        ...(parsed.head_sha ? { head_sha: parsed.head_sha } : {}),
        ...(parsed.head_sha && prHead ? { head_matches: headMatches } : {}),
        ...(parsed.findings ? { findings: parsed.findings } : {}),
        ...(parsed.citation ? { citation: parsed.citation } : {}),
        ...(parsed.sc_evidence ? { sc_evidence: parsed.sc_evidence } : {}),
        ...(parsed.verdict ? { verdict: parsed.verdict } : {}),
        ...(parsed.ui_evidence ? { ui_evidence: parsed.ui_evidence } : {}),
        ...(parsed.surface ? { surface: parsed.surface } : {}),
        fresh: true,
      };
      base.report = snap;
      if (nodeState?.planned_params?.role === "keel-verifier" && st?.worktree && headMatches && parsed.head_sha) {
        const route = nodeState.actual_route ?? {
          agent: nodeState.planned_params.agent as Harness,
          model: nodeState.planned_params.model,
          provider_id: nodeState.planned_params.provider_id,
          effort: nodeState.planned_params.effort,
        };
        const baseRef = facts?.snapshot.pr.baseRef ?? st.pr_binding?.base_ref;
        const computed = baseRef
          ? await node<{ base_sha?: string }>(ctx, "git/base-sha", { repo_dir: st.worktree, base_ref: baseRef }).catch(() => ({ base_sha: undefined as string | undefined }))
          : { base_sha: undefined as string | undefined };
        const baseSha = computed.base_sha ?? st.pr_binding?.base_sha;
        if (baseSha && route.model) {
          const pid = await node<{ ok?: boolean; patch_id?: string }>(ctx, "git/patch-id", { repo_dir: st.worktree, base_sha: baseSha, head_sha: parsed.head_sha }).catch(() => ({ ok: false, patch_id: undefined }));
          if (pid.ok && pid.patch_id) {
            const gv = buildVerdict({
              repo: gh ?? "",
              pr: st.pr ?? st.pr_binding?.number ?? 0,
              base_ref: baseRef ?? "",
              base_sha: baseSha,
              head_sha: parsed.head_sha,
              patch_id: pid.patch_id,
              report: verdictReportFromNode(parsed),
              route,
            });
            base.verdict = {
              head: gv.head_sha,
              base_ref: gv.base_ref,
              base_sha: gv.base_sha,
              patch_id: gv.patch_id,
              value: gv.level,
              level: gv.level,
              surface: gv.surface,
              by_route: gv.by_route as Verdict["by_route"],
              by_family: gv.by_family,
            };
            pendingSink = gv;
          }
        }
      }
    }
  }
  const { next, state } = await step(ctx, runId, base);
  if (pendingSink && finalKey && !(state.late_reports ?? []).some((r) => r.dispatch_key === finalKey)) {
    await recordVerifierVerdict(ctx, state, pendingSink);
  }
  if (state.g_route_choice && isGraphTaskType(state.g_route_choice)) {
    const pendingFile = await ctx.host.fs({ op: "read", root: "data", path: routePendingPath(runId) });
    if (pendingFile.ok && pendingFile.content) {
      const pending = JSON.parse(pendingFile.content) as RoutePending;
      const cfg = await loadRuntimeConfig(ctx.host);
      const profile = findProfile(cfg.manual, pending.profile_id);
      const calls = state.astra_calls;
      const left = state.budget.astra_left;
      const remat = await materializeRun(ctx, runId, profile, pending, state.g_route_choice);
      await withRun(ctx.host, runId, (raw) => {
        const s = raw as unknown as GraphRunState;
        s.astra_calls = calls;
        s.budget.astra_left = left;
        delete s.g_route_choice;
        delete s.consult_node;
        delete s.pending_astra_gate;
      });
      return { run_id: runId, next: remat.next };
    }
  }
  return { run_id: runId, next };
}

const CI_WAIT_NODES = new Set(["wait-ci", "ci-rerun-once"]);
const TOOL_PASS_NODES = new Set(["report", "report-ready"]);

function explicitPrNumber(pr: unknown): number | undefined {
  if (typeof pr === "number" && Number.isInteger(pr) && pr > 0) return pr;
  if (typeof pr === "string" && /^\d+$/.test(pr)) {
    const n = Number(pr);
    if (n > 0) return n;
  }
  return undefined;
}

function branchName(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  return ref.replace(/^refs\/heads\//, "");
}

async function bindPrFromWorktree(ctx: ToolContext, runId: string, worktree: string): Promise<{ bound: boolean; mismatch?: { pr: number; expected_branch?: string; actual_branch?: string } }> {
  const states = await loadGraphStates(ctx.host);
  const st = states.find((r) => (r as { run_id?: string }).run_id === runId) as GraphRunState | undefined;
  const git = await node<{ root?: string; branch?: string; head?: string; gh_repo?: string }>(ctx, "git/state", { repo_dir: worktree }).catch(() => ({ branch: undefined as string | undefined, gh_repo: undefined as string | undefined }));
  const actualBranch = branchName(git.branch);
  const given = st?.pr_explicit ? explicitPrNumber(st.pr) : undefined;
  let repo: string | undefined;
  let number: number | undefined;
  if (given) {
    number = given;
    repo = ghRepoOf(st!) ?? (isGhRepo(git.gh_repo) ? git.gh_repo : undefined);
  } else {
    const found = await node<{ repo: string; number: number } | null>(ctx, "pr/resolve", { repo_dir: worktree }).catch(() => null);
    if (!found?.number) return { bound: false };
    number = found.number;
    repo = found.repo;
  }
  const facts = await readPrFacts(ctx, { repo_dir: worktree, ...(repo ? { repo } : {}), pr: number });
  const expectedBranch = branchName(facts.snapshot.pr.headRef);
  if (given && expectedBranch && actualBranch && expectedBranch !== actualBranch) {
    return { bound: false, mismatch: { pr: given, expected_branch: expectedBranch, actual_branch: actualBranch } };
  }
  const baseRef = facts.snapshot.pr.baseRef;
  const head = facts.snapshot.pr.headSha ?? undefined;
  const headRepo = (isGhRepo(git.gh_repo) ? git.gh_repo : undefined) ?? facts.snapshot.pr.repo;
  const base = await node<{ base_sha?: string; base_ref: string }>(ctx, "git/base-sha", { repo_dir: worktree, base_ref: baseRef }).catch(() => ({ base_ref: baseRef, base_sha: undefined as string | undefined }));
  await withRun(ctx.host, runId, (raw) => {
    const s = raw as unknown as GraphRunState;
    if (!given) {
      s.pr = number;
      if (facts.snapshot.pr.repo) {
        s.gh_repo = facts.snapshot.pr.repo;
        s.repo = facts.snapshot.pr.repo;
      }
    }
    s.pr_binding = {
      repo: facts.snapshot.pr.repo,
      number: number!,
      ...(headRepo ? { head_repo: headRepo } : {}),
      ...(expectedBranch ? { branch: expectedBranch } : {}),
      ...(head ? { head_sha: head } : {}),
      ...(baseRef ? { base_ref: baseRef } : {}),
      ...(base.base_sha ? { base_sha: base.base_sha } : {}),
    };
  });
  return { bound: true };
}

export async function keelWait(ctx: ToolContext, args: Record<string, unknown>) {
  const runId = requireString(args, "run_id");
  await assertNotRunWorker(ctx, runId);
  const maxMinutes = Math.min(15, Math.max(1, typeof args.max_minutes === "number" ? args.max_minutes : 15));
  const start = ctx.host.now();
  const deadline = start + maxMinutes * 60_000;
  const states = await loadGraphStates(ctx.host);
  const st = states.find((r) => (r as { run_id?: string }).run_id === runId) as GraphRunState | undefined;
  const cursor = st?.cursor ?? "";
  const waited = () => Math.round((ctx.host.now() - start) / 1000);
  const keepWait = (note?: string) => ({
    run_id: runId,
    next: {
      ...(st?.next?.kind === "wait" ? st.next : { kind: "wait" as const, call: { tool: "keel_wait" as const, args: { run_id: runId, max_minutes: maxMinutes } } }),
      ...(note ? { note } : {}),
    },
    waited_seconds: waited(),
  });

  // A pending non-wait action (setup after a restart, a dispatch, a gate) is the lead's next step;
  // keel_wait must hand it back instead of inventing a "how do I wait" gate.
  if (st?.next && st.next.kind !== "wait") {
    const { next } = await step(ctx, runId, { type: "tick" });
    return { run_id: runId, next, waited_seconds: waited() };
  }

  const interval = pollIntervalMs(countWaitCiRuns(states as unknown as GraphRunState[]));

  if (cursor === "open-pr") {
    ctx.host.progress(ctx.callId);
    if (!st?.worktree) {
      return { run_id: runId, next: { kind: "decide" as const, gate_id: "open-pr", question: "open-pr 没有 worktree，无法查 PR。", options: ["retry", "stop"] }, waited_seconds: waited() };
    }
    const bind = await bindPrFromWorktree(ctx, runId, st.worktree);
    if (bind.mismatch) {
      return {
        run_id: runId,
        next: {
          kind: "decide" as const,
          gate_id: "human:pr",
          question: `显式 PR #${bind.mismatch.pr} 的分支是 ${bind.mismatch.expected_branch}，当前工作树是 ${bind.mismatch.actual_branch}。不能改绑。`,
          options: ["retry", "stop"],
          context: bind.mismatch,
        },
        waited_seconds: waited(),
      };
    }
    if (!bind.bound) return keepWait("尚未开 PR。主控先 pr_open，再 keel_wait。");
    const { next } = await step(ctx, runId, { type: "wait_done", on: "ok" });
    return { run_id: runId, next, waited_seconds: waited() };
  }

  const spec = PSTACK_GRAPHS[(st?.spec_id ?? st?.task_type) as GraphTaskType];
  const specNode = spec?.nodes.find((n) => n.id === cursor);
  const inflightNode = Object.values(st?.nodes ?? {}).find((n) => n.dispatch_state && n.dispatch_state !== "terminal" && n.dispatch_state !== "reported");
  if (specNode && (specNode.kind === "dispatch" || specNode.kind === "plugin_task") && inflightNode) {
    ctx.host.progress(ctx.callId);
    if (inflightNode.task?.run_id && ctx.host.tasks) {
      for (;;) {
        ctx.host.progress(ctx.callId);
        const invoked = await invokeCindyTasks(ctx.host.tasks, { phase: "getRun", task_run_id: inflightNode.task.run_id });
        const status = pickStrId(rec(invoked.ok ? invoked.data : {}).status);
        if (status === "completed" || status === "failed" || status === "cancelled") {
          const msgs = inflightNode.task.task_id
            ? await collectTaskMessages(ctx.host.tasks, inflightNode.task.task_id)
            : { ok: false as const, errorCode: "NO_TASK", message: "no task_id" };
          if (!msgs.ok) return keepWait(msgs.message);
          const selected = reportFromMessages(msgs.data, inflightNode.dispatch_key ?? "");
          if (selected.unconfirmed) return keepWait("任务报告未确认。");
          const inline = selected.report ?? { status: status === "completed" ? "done" : "failed", summary: status };
          if (status !== "completed") inline.status = "failed";
          const { next } = await step(ctx, runId, {
            type: "report",
            phase: "final",
            dispatch_key: inflightNode.dispatch_key,
            inline_report: {
              status: (inline.status === "partial" || inline.status === "blocked" || inline.status === "failed" ? inline.status : "done") as "done" | "partial" | "blocked" | "failed",
              summary: typeof inline.summary === "string" ? inline.summary : status,
            },
            report: {
              status: typeof inline.status === "string" ? inline.status : status === "completed" ? "done" : "failed",
              summary: typeof inline.summary === "string" ? inline.summary : status,
              citation: typeof inline.citation === "string" ? inline.citation : undefined,
              sc_evidence: inline.sc_evidence && typeof inline.sc_evidence === "object" ? inline.sc_evidence as Record<string, boolean> : undefined,
              ran: Array.isArray(inline.ran) ? inline.ran as NodeReportSnap["ran"] : undefined,
              files_changed: Array.isArray(inline.files_changed) ? inline.files_changed as string[] : undefined,
              fresh: true,
            },
          });
          return { run_id: runId, next, waited_seconds: waited() };
        }
        if (ctx.host.now() + interval > deadline) return keepWait();
        await ctx.host.sleep(interval);
      }
    }
    const { next } = await step(ctx, runId, { type: "tick" });
    return { run_id: runId, next, waited_seconds: waited() };
  }

  if (CI_WAIT_NODES.has(cursor)) {
    if (st?.worktree) {
      ctx.host.progress(ctx.callId);
      const bind = await bindPrFromWorktree(ctx, runId, st.worktree);
      if (bind.mismatch) {
        return {
          run_id: runId,
          next: {
            kind: "decide" as const,
            gate_id: "human:pr",
            question: `显式 PR #${bind.mismatch.pr} 的分支是 ${bind.mismatch.expected_branch}，当前工作树是 ${bind.mismatch.actual_branch}。不能改绑。`,
            options: ["retry", "stop"],
            context: bind.mismatch,
          },
          waited_seconds: waited(),
        };
      }
      if (st.pr == null && !bind.bound) return keepWait("尚未开 PR。");
    }
    const fresh = (await loadGraphStates(ctx.host)).find((r) => (r as { run_id?: string }).run_id === runId) as GraphRunState | undefined;
    if (fresh?.pr == null) return keepWait("wait-ci 还没有绑定 PR。");
    let on: ReturnType<typeof waitOnFromFacts> = "wait";
    for (;;) {
      ctx.host.progress(ctx.callId);
      const gh = ghRepoOf(fresh);
      const facts = await readPrFacts(ctx, { ...(gh ? { repo: gh } : {}), pr: fresh.pr, repo_dir: fresh.worktree });
      on = waitOnFromFacts(facts);
      if (on !== "wait") break;
      if (ctx.host.now() + interval > deadline) return keepWait();
      await ctx.host.sleep(interval);
    }
    const { next } = await step(ctx, runId, { type: "wait_done", on });
    return { run_id: runId, next, waited_seconds: waited() };
  }

  if (TOOL_PASS_NODES.has(cursor)) {
    ctx.host.progress(ctx.callId);
    const { next } = await step(ctx, runId, { type: "wait_done", on: "ok" });
    return { run_id: runId, next, waited_seconds: waited() };
  }

  if (cursor === "done") {
    ctx.host.progress(ctx.callId);
    const { next } = await step(ctx, runId, { type: "tick" });
    return { run_id: runId, next, waited_seconds: waited() };
  }

  return {
    run_id: runId,
    next: { kind: "decide" as const, gate_id: cursor || "wait", question: `不清楚节点 ${cursor || "(空)"} 该如何等待，不要无限等。`, options: ["retry", "stop"], context: { cursor } },
    waited_seconds: waited(),
  };
}

export async function keelGate(ctx: ToolContext, args: Record<string, unknown>) {
  const runId = requireString(args, "run_id");
  await assertNotRunWorker(ctx, runId);
  const gateId = requireString(args, "gate_id");
  const answer = requireString(args, "answer");
  const reason = typeof args.reason === "string" ? args.reason : undefined;
  if (gateId === "G-route" || gateId === "profile") {
    const pendingFile = await ctx.host.fs({ op: "read", root: "data", path: routePendingPath(runId) });
    if (pendingFile.ok && pendingFile.content) {
      const pending = JSON.parse(pendingFile.content) as RoutePending;
      const cfg = await loadRuntimeConfig(ctx.host);
      if (gateId === "G-route") {
        if (!isGraphTaskType(answer)) throw new KeelError("INVALID_INPUT", `G-route 答案必须是单元图，收到 ${answer}。`);
        const profile = findProfile(cfg.manual, pending.profile_id);
        const out = await materializeRun(ctx, runId, profile, pending, answer);
        return { run_id: runId, next: out.next, gate_id: gateId, answer };
      }
      const profile = findProfile(cfg.manual, answer);
      const filled: RoutePending = { ...pending, profile_id: profile.id };
      const routed = await resolveGraphTask(ctx, {
        goal: filled.goal,
        playbook: filled.playbook,
        ...(filled.pr !== undefined ? { pr: filled.pr } : {}),
        run_id: runId,
        profile,
      });
      if ("decide" in routed) {
        await ctx.host.fs({ op: "write", root: "data", path: routePendingPath(runId), content: JSON.stringify(filled) });
        await ctx.host.fs({
          op: "write",
          root: "data",
          path: `runs/${runId}/graph-state.json`,
          content: JSON.stringify({ run_id: runId, profile_id: profile.id, goal: filled.goal, status: "await_sol", next: routed.decide }),
        });
        return { run_id: runId, next: routed.decide, gate_id: gateId, answer };
      }
      if ("astra" in routed) {
        const out = await startEntryAstraConsult(ctx, runId, profile, filled, routed.astra);
        return { run_id: runId, next: out.next, gate_id: gateId, answer };
      }
      const out = await materializeRun(ctx, runId, profile, filled, routed.taskType);
      return { run_id: runId, next: out.next, gate_id: gateId, answer };
    }
  }
  await withRun(ctx.host, runId, (raw) => {
    const s = raw as unknown as GraphRunState;
    if (!Array.isArray(s.sol_decisions)) s.sol_decisions = [];
    const attempt = s.nodes[gateId]?.attempts ?? 0;
    s.sol_decisions.push({ gate_id: gateId, attempt, answer, ...(reason ? { reason } : {}) } satisfies GateAnswer);
  });
  const { next } = await step(ctx, runId, { type: "tick" });
  return { run_id: runId, next, gate_id: gateId, answer };
}

export async function keelStatus(ctx: ToolContext, args: Record<string, unknown>) {
  const only = typeof args.run_id === "string" ? args.run_id : undefined;
  const runs = (await loadGraphStates(ctx.host))
    .map((r) => r as unknown as GraphRunState)
    .filter((r) => r.run_id && (!only || r.run_id === only));
  return {
    runs: runs.map((r) => ({
      run_id: r.run_id,
      status: r.status,
      next: r.next,
      current_nodes: r.cursor ? [r.cursor] : [],
      pr: r.pr,
      astra_calls: r.astra_calls,
      gates_open: r.status === "waiting_human" || r.status === "await_sol" ? 1 : 0,
    })),
  };
}
