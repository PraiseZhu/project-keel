// Main-control protocol: keel_run / report / wait / gate / status.
// Sol follows next; this module wires interpreter, gates, done facts, brief, index, and view.

import { family } from "../../shared/fanout.ts";
import { loadRuntimeConfig } from "../config.ts";
import { node, requireString, type ToolContext } from "../context.ts";
import { loadGraphStates } from "../graph-snapshot.ts";
import { isChangeGraphDone, isInvestigationDone, type ChangeGraphDoneInput, type ChangeGraphDoneResult } from "../graph/done.ts";
import { type Evidence, type GateId } from "../graph/gates.ts";
import { classifyRetry, createRun, advance, type AdvanceEvent, type DoneCheckResult, type GateHooks, type ReconcileQueries } from "../graph/interpreter.ts";
import { readPrFacts, type PrFacts } from "../graph/pr-facts.ts";
import { parseNodeReport, type NodeReport } from "../graph/report.ts";
import { checkScope } from "../graph/scope.ts";
import { ensureNode, parseDispatchKey, type ErrorMode, type GateAnswer, type GraphRunState, type Next, type NodeReportSnap, type Verdict } from "../graph/state.ts";
import { buildVerdict, type GraphVerdict, type NodeReport as VerdictReport } from "../graph/verdict.ts";
import { KeelError, type Host } from "../host.ts";
import { runGate, type GateDecision, type GateStore, type GraphKind } from "../jev/gates.ts";
import { newRunId } from "../ledger.ts";
import { findProfile, resolveProfileForHarness } from "../manual/resolve.ts";
import { toActiveIndex, writeActiveIndex } from "../store/active-index.ts";
import { withRun } from "../store/runs.ts";
import { PSTACK_GRAPHS, TASK_TYPES, type GraphTaskType } from "../../shared/graph/pstack.ts";
import type { Harness, ModelManual, Profile } from "../../shared/manual/schema.ts";
import { keywordRoute } from "./pstack.ts";

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
  const workers = Array.isArray(o.workers) ? o.workers as NonNullable<ReconcileQueries["list_workers"]>["workers"] : undefined;
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

/** start_team receipt first, else get_workspace_info workflow id. */
export function resolveTeamId(...sources: unknown[]): string | undefined {
  for (const src of sources) {
    if (!src || typeof src !== "object" || Array.isArray(src)) continue;
    const o = src as Record<string, unknown>;
    const id = str(o.team_id) ?? str(o.teamId) ?? str(o.workflow_id) ?? str(o.workflowId);
    if (id) return id;
  }
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

/** Copy worker fields only. Do not invent surface or ui_evidence. */
export function verdictReportFromNode(report: NodeReport): VerdictReport {
  return {
    dispatch_key: report.dispatch_key,
    status: report.status,
    summary: report.summary,
    ...(report.verdict ? { verdict: report.verdict } : {}),
    ran: report.ran,
    ...(report.findings ? { findings: report.findings } : {}),
    ...(report.surface ? { surface: report.surface } : {}),
    ...(report.ui_evidence ? { ui_evidence: report.ui_evidence } : {}),
  };
}

function taskTypeOf(goal: string, playbook: string | undefined, pr: unknown): GraphTaskType {
  if (pr !== undefined && pr !== null && pr !== "") return "pr";
  if (playbook && (TASK_TYPES as readonly string[]).includes(playbook)) return playbook as GraphTaskType;
  const kw = keywordRoute(goal);
  if (kw === "bug-fix" || kw === "feature" || kw === "refactoring" || kw === "investigation") return kw;
  if (kw === "opening-a-pr" || kw === "babysit" || kw === "shipping") return "pr";
  return "bug-fix";
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
    if (decision.routed === "lead" || decision.routed === "astra") return undefined;
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
    repo: String(state.repo ?? ""),
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

function scRows(state: GraphRunState): { id: string; hasEvidence: boolean }[] {
  const evidence: Record<string, boolean> = {};
  for (const n of Object.values(state.nodes)) Object.assign(evidence, n.last_report?.sc_evidence ?? {});
  return (state.sc ?? []).map((s) => ({ id: s.id, hasEvidence: evidence[s.id] === true }));
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
    const current = await readContentFingerprint(ctx, state.repo ?? state.worktree ?? "");
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
    if (state.pr != null) facts = await readPrFacts(ctx, { repo: state.repo, pr: state.pr, repo_dir: state.worktree });
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
  const base = state.pr_binding?.base_sha ?? state.verdict?.base_sha ?? "";
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
  if (result.done) return { ok: true, summary: "变更图完成" };
  return { ok: false, next: mapChangeDoneFailure(state, result) };
}

async function persistSideEffects(host: Host, state: GraphRunState): Promise<void> {
  const runs = await loadGraphStates(host);
  const entries = runs.map((r) => {
    const s = r as unknown as GraphRunState;
    return {
      workdir: String(s.worktree || s.repo || ""),
      run_id: String(s.run_id || ""),
      status: String(s.status || ""),
      current_node: String(s.cursor || ""),
      updated_at: new Date(s.updated_at || host.now()).toISOString(),
    };
  });
  await writeActiveIndex(host, toActiveIndex(entries.filter((e) => e.workdir && e.run_id)));
  host.broadcast({ type: "graph-delta", run_id: state.run_id, status: state.status, next: state.next, cursor: state.cursor, at: new Date(host.now()).toISOString() });
}

async function step(ctx: ToolContext, runId: string, event: AdvanceEvent): Promise<{ next: Next; state: GraphRunState }> {
  const cfg = await loadRuntimeConfig(ctx.host);
  const states = await loadGraphStates(ctx.host);
  const st = states.find((r) => (r as { run_id?: string }).run_id === runId) as GraphRunState | undefined;
  let profile;
  try { profile = st?.profile_id ? findProfile(cfg.manual, st.profile_id) : undefined; } catch { profile = undefined; }
  const graph = (st?.task_type ?? "bug-fix") as GraphKind;
  const out = await advance(ctx.host, runId, event, {
    gates: makeGates(ctx, runId, graph, profile?.direction_gate === "astra" ? "astra" : "lead"),
    doneCheck: (state) => runDoneCheck(ctx, state),
  });
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
  if (!picked.profile) {
    return pack(runId, undefined, picked.decide!);
  }
  const pr = typeof args.pr === "number" || typeof args.pr === "string" ? args.pr : undefined;
  const taskType = taskTypeOf(goal, str(args.playbook), pr);
  const spec = PSTACK_GRAPHS[taskType];
  let worktree: string | undefined;
  let start_state: { head?: string; status_digest?: string; content_hash?: string } | undefined;
  let origin: string | undefined;
  try {
    const st = await node<{ root?: string; branch?: string; head?: string }>(ctx, "git/state", { repo_dir: repoDir });
    origin = st.root;
    if (taskType === "investigation") {
      const fp = await readContentFingerprint(ctx, repoDir);
      if (!fp) throw new KeelError("FINGERPRINT_UNKNOWN", "起始指纹未知，调查未完成。");
      start_state = fp;
    } else if (taskType === "pr") {
      const branch = str(args.branch) ?? st.branch;
      if (!branch || branch === "HEAD") throw new KeelError("WORKTREE_FAILED", "pr 类型需要已有功能分支。");
      const wt = await node<{ path?: string; occupied?: string; branch?: string }>(ctx, "worktree/create", {
        repo_dir: repoDir, name: `keel-${runId}`, existing: true, branch,
      });
      if (wt.occupied) {
        return pack(runId, picked.profile, { kind: "stop", reason: `分支 ${wt.branch ?? branch} 已在 ${wt.occupied} 检出。`, needs_user: ["释放占用的工作树，或指定空闲 worktree"] });
      }
      worktree = wt.path;
    } else {
      const wt = await node<{ path?: string }>(ctx, "worktree/create", { repo_dir: repoDir, name: `keel-${runId}` });
      worktree = wt.path;
    }
  } catch (e) {
    if (e instanceof KeelError) throw e;
    throw new KeelError("WORKTREE_FAILED", e instanceof Error ? e.message : String(e));
  }
  const sc = Array.isArray(args.sc) ? (args.sc as { id: string; text: string; verify?: string }[]) : [];
  const scopeAllow = Array.isArray(args.scope) && args.scope.every((x) => typeof x === "string") ? (args.scope as string[]) : undefined;
  await createRun(ctx.host, {
    run_id: runId,
    spec_id: spec.id,
    profile_id: picked.profile.id,
    lead_harness: picked.profile.harness,
    task_type: taskType,
    entry: spec.entry,
    goal,
    sc,
    repo: origin,
    worktree,
    pr,
    start_state,
    astra_budget: cfg.limits.astraBudget,
    now: ctx.host.now(),
    ...(scopeAllow ? { scopeAllow } : {}),
  });
  const { next, state } = await step(ctx, runId, { type: "tick" });
  return pack(runId, picked.profile, next, { spec_id: spec.id, worktree: state.worktree });
}

export async function keelReport(ctx: ToolContext, args: Record<string, unknown>) {
  const runId = requireString(args, "run_id");
  const phase = requireString(args, "phase");
  if (!["setup", "accepted", "reconcile", "recover", "final"].includes(phase)) {
    throw new KeelError("INVALID_INPUT", "phase 须为 setup | accepted | reconcile | recover | final。");
  }
  const base: Extract<AdvanceEvent, { type: "report" }> = { type: "report", phase: phase as Extract<AdvanceEvent, { type: "report" }> ["phase"] };
  if (phase === "setup") {
    const outcome = args.outcome && typeof args.outcome === "object" ? { ...(args.outcome as Record<string, unknown>) } : { ...args };
    const team_id = resolveTeamId(outcome, args, args.workspace_info, args.get_workspace_info);
    const session = str(args.session_id) ?? str(outcome.session_id) ?? str(outcome.lead_session_id);
    if (team_id) outcome.team_id = team_id;
    if (session) base.session_id = session;
    base.outcome = outcome;
  }
  if (phase === "accepted") {
    const mapped = mapCreateWorkerReceipt(args);
    Object.assign(base, mapped);
    if (typeof args.dispatch_key === "string") base.dispatch_key = args.dispatch_key;
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
      const team_id = list.team_id ?? resolveTeamId(ar, args, args.workspace_info, args.get_workspace_info);
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
  if (phase === "final") {
    const key = requireString(args, "dispatch_key");
    base.dispatch_key = key;
    const parsedKey = parseDispatchKey(key);
    const states = await loadGraphStates(ctx.host);
    const st = states.find((r) => (r as { run_id?: string }).run_id === runId) as GraphRunState | undefined;
    const worktree = st?.worktree;
    let parsed: NodeReport | undefined;
    const inline = args.inline_report && typeof args.inline_report === "object" ? args.inline_report as Record<string, unknown> : undefined;
    if (inline) {
      base.inline_report = { status: (typeof inline.status === "string" ? inline.status : "done") as "done" | "partial" | "blocked" | "failed", summary: typeof inline.summary === "string" ? inline.summary : undefined };
      parsed = {
        dispatch_key: key,
        status: (typeof inline.status === "string" ? inline.status : "done") as NodeReport["status"],
        summary: typeof inline.summary === "string" ? inline.summary : "",
        files_changed: Array.isArray(inline.files_changed) ? inline.files_changed.filter((x): x is string => typeof x === "string") : [],
        ran: Array.isArray(inline.ran) ? inline.ran as NodeReport["ran"] : [],
        ...(typeof inline.citation === "string" ? { citation: inline.citation } : {}),
        ...(inline.sc_evidence && typeof inline.sc_evidence === "object" ? { sc_evidence: inline.sc_evidence as Record<string, boolean> } : {}),
        ...(typeof inline.head_sha === "string" ? { head_sha: inline.head_sha } : {}),
        ...(typeof inline.verdict === "string" ? { verdict: inline.verdict as NodeReport["verdict"] } : {}),
        ...(Array.isArray(inline.ui_evidence) ? { ui_evidence: inline.ui_evidence.filter((x): x is string => typeof x === "string") } : {}),
        ...(inline.surface === "live-ui" || inline.surface === "unit-test" || inline.surface === "type-check" || inline.surface === "blocked" ? { surface: inline.surface } : {}),
      };
    } else {
      if (!worktree || !parsedKey) throw new KeelError("REPORT_INVALID", "final 需要 worktree 与 dispatch_key。");
      const file = await node<{ path: string; content: string }>(ctx, "report/read", { worktree, node: parsedKey.nodeId, attempt: parsedKey.attempt });
      parsed = parseNodeReport(file.content, key);
      base.report_path = file.path;
    }
    const nodeState = parsedKey ? st?.nodes?.[parsedKey.nodeId] : undefined;
    if (nodeState?.planned_params?.writes) {
      const allow = nodeState.planned_params.scopeAllow;
      if (!allow?.length) throw new KeelError("SCOPE_VIOLATION", "该节点 planned_params 没有写域，拒绝落盘。");
      const changed = await node<{ files: string[] }>(ctx, "git/changed-files", { repo_dir: worktree ?? st?.worktree ?? "" });
      const scope = checkScope(changed.files ?? [], allow);
      if (!scope.ok) throw new KeelError("SCOPE_VIOLATION", `写域越界：${scope.violations.join("、")}`, { violations: scope.violations });
    }
    if (parsed) {
      let headMatches: boolean | undefined;
      if (parsed.head_sha && (worktree || st?.worktree)) {
        try {
          const stGit = await node<{ head?: string }>(ctx, "git/state", { repo_dir: worktree ?? st?.worktree ?? "" });
          if (stGit.head) headMatches = stGit.head === parsed.head_sha;
        } catch { /* unknown head is not a match */ }
      }
      const snap: NodeReportSnap = {
        status: parsed.status,
        summary: parsed.summary,
        ran: parsed.ran,
        files_changed: parsed.files_changed,
        ...(parsed.head_sha ? { head_sha: parsed.head_sha } : {}),
        ...(headMatches !== undefined ? { head_matches: headMatches } : {}),
        ...(parsed.findings ? { findings: parsed.findings } : {}),
        ...(parsed.citation ? { citation: parsed.citation } : {}),
        ...(parsed.sc_evidence ? { sc_evidence: parsed.sc_evidence } : {}),
        ...(parsed.verdict ? { verdict: parsed.verdict } : {}),
        ...(parsed.ui_evidence ? { ui_evidence: parsed.ui_evidence } : {}),
        ...(parsed.surface ? { surface: parsed.surface } : {}),
        fresh: true,
      };
      base.report = snap;
      if (nodeState?.planned_params?.role === "keel-verifier" && st?.worktree) {
        const route = nodeState.actual_route ?? {
          agent: nodeState.planned_params.agent as Harness,
          model: nodeState.planned_params.model,
          provider_id: nodeState.planned_params.provider_id,
          effort: nodeState.planned_params.effort,
        };
        const stGit = await node<{ head?: string }>(ctx, "git/state", { repo_dir: st.worktree }).catch(() => ({ head: undefined }));
        const headSha = stGit.head;
        const baseSha = st.pr_binding?.base_sha;
        if (baseSha && headSha && route.model) {
          const pid = await node<{ ok?: boolean; patch_id?: string }>(ctx, "git/patch-id", { repo_dir: st.worktree, base_sha: baseSha, head_sha: headSha }).catch(() => ({ ok: false, patch_id: undefined }));
          if (pid.ok && pid.patch_id) {
            const gv = buildVerdict({
              repo: String(st.repo ?? st.pr_binding?.repo ?? ""),
              pr: st.pr ?? st.pr_binding?.number ?? 0,
              base_ref: st.pr_binding?.base_ref ?? "",
              base_sha: baseSha,
              head_sha: headSha,
              patch_id: pid.patch_id,
              report: verdictReportFromNode(parsed),
              route,
            });
            const verdict: Verdict = {
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
            base.verdict = verdict;
          }
        }
      }
    }
  }
  const { next } = await step(ctx, runId, base);
  return { run_id: runId, next };
}

const CI_WAIT_NODES = new Set(["wait-ci", "ci-rerun-once"]);
const TOOL_PASS_NODES = new Set(["report", "report-ready", "verify-head"]);

async function bindPrFromWorktree(ctx: ToolContext, runId: string, worktree: string): Promise<{ bound: boolean; next?: Next }> {
  const found = await node<{ repo: string; number: number } | null>(ctx, "pr/resolve", { repo_dir: worktree }).catch(() => null);
  if (!found?.number) return { bound: false };
  const facts = await readPrFacts(ctx, { repo_dir: worktree, repo: found.repo, pr: found.number });
  const baseRef = facts.snapshot.pr.baseRef;
  const head = facts.snapshot.pr.headSha ?? undefined;
  const base = await node<{ base_sha?: string; base_ref: string }>(ctx, "git/base-sha", { repo_dir: worktree, base_ref: baseRef }).catch(() => ({ base_ref: baseRef, base_sha: undefined as string | undefined }));
  await withRun(ctx.host, runId, (raw) => {
    const s = raw as unknown as GraphRunState;
    s.pr = found.number;
    s.repo = found.repo;
    s.pr_binding = {
      repo: found.repo,
      number: found.number,
      ...(head ? { head_sha: head } : {}),
      ...(baseRef ? { base_ref: baseRef } : {}),
      ...(base.base_sha ? { base_sha: base.base_sha } : {}),
    };
  });
  return { bound: true };
}

export async function keelWait(ctx: ToolContext, args: Record<string, unknown>) {
  const runId = requireString(args, "run_id");
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

  if (cursor === "open-pr") {
    ctx.host.progress(ctx.callId);
    if (!st?.worktree) {
      return { run_id: runId, next: { kind: "decide" as const, gate_id: "open-pr", question: "open-pr 没有 worktree，无法查 PR。", options: ["retry", "stop"] }, waited_seconds: waited() };
    }
    const bind = await bindPrFromWorktree(ctx, runId, st.worktree);
    if (!bind.bound) return keepWait("尚未开 PR。主控先 pr_open，再 keel_wait。");
    const { next } = await step(ctx, runId, { type: "wait_done", on: "ok" });
    return { run_id: runId, next, waited_seconds: waited() };
  }

  if (CI_WAIT_NODES.has(cursor)) {
    if (st?.pr == null && st?.worktree) {
      ctx.host.progress(ctx.callId);
      const bind = await bindPrFromWorktree(ctx, runId, st.worktree);
      if (!bind.bound) return keepWait("尚未开 PR。");
    }
    const fresh = (await loadGraphStates(ctx.host)).find((r) => (r as { run_id?: string }).run_id === runId) as GraphRunState | undefined;
    if (fresh?.pr == null) return keepWait("wait-ci 还没有绑定 PR。");
    let on: ReturnType<typeof waitOnFromFacts> = "wait";
    for (;;) {
      ctx.host.progress(ctx.callId);
      const facts = await readPrFacts(ctx, { repo: fresh.repo, pr: fresh.pr, repo_dir: fresh.worktree });
      on = waitOnFromFacts(facts);
      if (on !== "wait") break;
      if (ctx.host.now() + 15_000 > deadline) return keepWait();
      await ctx.host.sleep(15_000);
    }
    const { next } = await step(ctx, runId, { type: "wait_done", on });
    return { run_id: runId, next, waited_seconds: waited() };
  }

  if (TOOL_PASS_NODES.has(cursor)) {
    ctx.host.progress(ctx.callId);
    const { next } = await step(ctx, runId, { type: "wait_done", on: "ok" });
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
  const gateId = requireString(args, "gate_id");
  const answer = requireString(args, "answer");
  const reason = typeof args.reason === "string" ? args.reason : undefined;
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
