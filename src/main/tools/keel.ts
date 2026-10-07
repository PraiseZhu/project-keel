// Main-control protocol: keel_run / report / wait / gate / status.
// Sol follows next; this module wires interpreter, gates, done facts, brief, index, and view.

import { loadRuntimeConfig } from "../config.ts";
import { node, requireString, type ToolContext } from "../context.ts";
import { loadGraphStates } from "../graph-snapshot.ts";
import { isInvestigationDone } from "../graph/done.ts";
import { GATES, type Evidence } from "../graph/gates.ts";
import { classifyRetry, createRun, advance, type AdvanceEvent, type GateHooks, type ReconcileQueries } from "../graph/interpreter.ts";
import { readPrFacts } from "../graph/pr-facts.ts";
import { parseNodeReport, type NodeReport } from "../graph/report.ts";
import { checkScope } from "../graph/scope.ts";
import type { NodeReport as VerdictReport } from "../graph/verdict.ts";
import { parseDispatchKey, type ErrorMode, type GraphRunState, type Next } from "../graph/state.ts";
import { KeelError, type Host } from "../host.ts";
import { newRunId } from "../ledger.ts";
import { findProfile, resolveProfileForHarness } from "../manual/resolve.ts";
import { toActiveIndex, writeActiveIndex } from "../store/active-index.ts";
import { PSTACK_GRAPHS, TASK_TYPES, type GraphTaskType } from "../../shared/graph/pstack.ts";
import type { Harness, ModelManual, Profile } from "../../shared/manual/schema.ts";
import { keywordRoute } from "./pstack.ts";

const LEADS = new Set<Harness>(["codex", "claude-code", "pi"]);
const gateAnswers = new Map<string, Map<string, string>>();
const lastAdvanceEvidence = new Map<string, Evidence>();

export function isFailFirstNode(nodeId: string): boolean {
  const id = nodeId.toLowerCase();
  return id === "reproduce" || id.includes("fail-first") || id.includes("failing-test");
}

/**
 * G-advance exit_code is acceptance, not the raw command status.
 * Fail-first / reproduce: expected test failure → 0; unexpected pass → 1.
 */
export function acceptanceExitCode(nodeId: string, ran: readonly { cmd: string; exit_code: number }[]): number | undefined {
  if (!ran.length) return undefined;
  const anyFail = ran.some((r) => r.exit_code !== 0);
  if (isFailFirstNode(nodeId)) return anyFail ? 0 : 1;
  const last = ran[ran.length - 1]!;
  return anyFail ? last.exit_code || 1 : 0;
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
    evidence_present: ran.length > 0,
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
  return {
    ok,
    complete,
    ...(workers ? { workers } : {}),
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

function makeGates(runId: string): GateHooks {
  const lookup = (id: string) => gateAnswers.get(runId)?.get(id);
  return {
    retry: (input) => {
      const a = lookup(input.node);
      if (a === "retry" || a === "escalate" || a === "stop" || a === "human") return a;
      const v = GATES["G-retry"].deterministic({ consecutive_failures: input.consecutive_failures, error_mode: input.error_mode });
      if (v === "retry" || v === "escalate" || v === "stop") return v;
      return classifyRetry(input.error_mode as ErrorMode | undefined, input.consecutive_failures).decision;
    },
    advance: ({ node }) => {
      const a = lookup(node);
      if (a === "advance" || a === "stay") return a;
      const ev = lastAdvanceEvidence.get(runId);
      if (!ev) return undefined;
      const v = GATES["G-advance"].deterministic(ev);
      // Consumed: a later look without a new report/commit is not new_evidence.
      lastAdvanceEvidence.set(runId, { ...ev, new_evidence: false });
      if (v === "advance" || v === "stay") return v;
      return undefined;
    },
    accept: ({ node }) => {
      const a = lookup(node);
      if (a === "adopt" || a === "revise" || a === "ask_user") return a;
      return undefined;
    },
    arena: ({ node }) => {
      const a = lookup(node);
      if (a === "single" || a === "arena") return a;
      return undefined;
    },
  };
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
  const out = await advance(ctx.host, runId, event, { gates: makeGates(runId) });
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
  if (phase === "setup") base.outcome = args.outcome && typeof args.outcome === "object" ? args.outcome as Record<string, unknown> : args;
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
    };
    if (typeof args.dispatch_key === "string") base.dispatch_key = args.dispatch_key;
  }
  if (phase === "recover") {
    if (typeof args.action === "string") base.action = args.action as "send_initial" | "diagnose" | "archive" | "verify_stopped";
    if (args.action_result && typeof args.action_result === "object") base.action_result = args.action_result as Record<string, unknown>;
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
    if (args.inline_report && typeof args.inline_report === "object") {
      base.inline_report = args.inline_report as { status: "done" | "partial" | "blocked" | "failed"; summary?: string };
    } else {
      if (!worktree || !parsedKey) throw new KeelError("REPORT_INVALID", "final 需要 worktree 与 dispatch_key。");
      const file = await node<{ path: string; content: string }>(ctx, "report/read", { worktree, node: parsedKey.nodeId, attempt: parsedKey.attempt });
      parsed = parseNodeReport(file.content, key);
      base.report_path = file.path;
      const nodeState = st.nodes?.[parsedKey.nodeId];
      if (nodeState?.planned_params?.writes) {
        const changed = await node<{ files: string[] }>(ctx, "git/changed-files", { repo_dir: worktree });
        const allow = (args.scope as string[] | undefined) ?? ["**"];
        const scope = checkScope(changed.files ?? [], allow);
        if (!scope.ok) throw new KeelError("SCOPE_VIOLATION", `写域越界：${scope.violations.join("、")}`, { violations: scope.violations });
      }
      let headMatches: boolean | undefined;
      if (parsed.head_sha) {
        try {
          const stGit = await node<{ head?: string }>(ctx, "git/state", { repo_dir: worktree });
          if (typeof stGit.head === "string" && stGit.head) headMatches = stGit.head === parsed.head_sha;
        } catch {
          headMatches = undefined;
        }
      }
      lastAdvanceEvidence.set(runId, advanceEvidenceForNode({
        nodeId: parsedKey.nodeId,
        ran: parsed.ran,
        ...(headMatches !== undefined ? { head_matches: headMatches } : {}),
        new_report: true,
        new_commit: parsed.files_changed.length > 0,
      }));
    }
    if (st?.task_type === "investigation") {
      const startFp = completeStartState(st.start_state);
      const current = await readContentFingerprint(ctx, st.repo ?? worktree ?? "");
      if (!startFp || !current) throw new KeelError("FINGERPRINT_UNKNOWN", "内容指纹未知，调查未完成。");
      const evalDone = isInvestigationDone({
        reportComplete: true,
        reportCitation: typeof (args.inline_report as { summary?: string } | undefined)?.summary === "string" ? (args.inline_report as { summary: string }).summary : parsed?.summary ?? "inline",
        sc: (st.sc ?? []).map((s) => ({ id: s.id, hasEvidence: true })),
        openHumanGates: st.status === "waiting_human" ? 1 : 0,
        start: startFp,
        current,
      });
      if (!evalDone.done) throw new KeelError("SCOPE_VIOLATION", evalDone.missing.join("；"), { missing: evalDone.missing });
    }
  }
  const { next } = await step(ctx, runId, base);
  return { run_id: runId, next };
}

export async function keelWait(ctx: ToolContext, args: Record<string, unknown>) {
  const runId = requireString(args, "run_id");
  const maxMinutes = Math.min(15, Math.max(1, typeof args.max_minutes === "number" ? args.max_minutes : 15));
  const start = ctx.host.now();
  const deadline = start + maxMinutes * 60_000;
  const states = await loadGraphStates(ctx.host);
  const st = states.find((r) => (r as { run_id?: string }).run_id === runId) as GraphRunState | undefined;
  if (st?.pr !== undefined && st.pr !== null) {
    for (;;) {
      ctx.host.progress(ctx.callId);
      const facts = await readPrFacts(ctx, { repo: st.repo, pr: st.pr, repo_dir: st.worktree });
      if (facts.nextAction !== "wait_for_ci") break;
      if (ctx.host.now() + 15_000 > deadline) break;
      await ctx.host.sleep(15_000);
    }
  } else {
    ctx.host.progress(ctx.callId);
    if (ctx.host.now() + 15_000 <= deadline) await ctx.host.sleep(15_000);
  }
  const { next } = await step(ctx, runId, { type: "wait_done", on: "ok" });
  return { run_id: runId, next, waited_seconds: Math.round((ctx.host.now() - start) / 1000) };
}

export async function keelGate(ctx: ToolContext, args: Record<string, unknown>) {
  const runId = requireString(args, "run_id");
  const gateId = requireString(args, "gate_id");
  const answer = requireString(args, "answer");
  let m = gateAnswers.get(runId);
  if (!m) { m = new Map(); gateAnswers.set(runId, m); }
  m.set(gateId, answer);
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
