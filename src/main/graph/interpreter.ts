// Graph interpreter: one withRun transaction per advance. External work is returned as next.

import { loadRuntimeConfig, type RuntimeConfig } from "../config.ts";
import { KeelError, type Host } from "../host.ts";
import { resolve } from "../manual/resolve.ts";
import { withRun, type GraphState } from "../store/runs.ts";
import { family } from "../../shared/fanout.ts";
import { PSTACK_GRAPHS } from "../../shared/graph/pstack.ts";
import { buildBrief } from "./brief.ts";
import type { EdgeOn, GraphNode, GraphSpec } from "../../shared/graph/spec.ts";
import type { AgentModel, ModelManual, Role, Route } from "../../shared/manual/schema.ts";
import {
  ACCEPTED_TIMEOUT_MS,
  dispatchKey,
  ensureNode,
  initGraphState,
  keelRoleFor,
  MAX_RECONCILE_ROUNDS,
  MAX_RECOVER_TIMEOUTS,
  parseDispatchKey,
  PLANNED_TIMEOUT_MS,
  RECONCILE_TIMEOUT_MS,
  RECOVER_TIMEOUT_MS,
  type CreateWorkerParams,
  type ErrorMode,
  type GraphRunState,
  type InitRunOpts,
  type Next,
  type NodeReportSnap,
  type NodeRunState,
  type PlannedParams,
  type RecoverAction,
} from "./state.ts";

export type RetryDecision = "retry" | "escalate" | "stop" | "human";
export type AdvanceDecision = "advance" | "stay";
export type AcceptDecision = "adopt" | "revise" | "ask_user";
export type ArenaDecision = "single" | "arena";

export interface GateHooks {
  retry?(input: { node: string; error_mode?: string; consecutive_failures: number; state: GraphRunState }): RetryDecision | undefined | Promise<RetryDecision | undefined>;
  advance?(input: { node: string; state: GraphRunState }): AdvanceDecision | undefined | Promise<AdvanceDecision | undefined>;
  accept?(input: { node: string; state: GraphRunState }): AcceptDecision | undefined | Promise<AcceptDecision | undefined>;
  arena?(input: { node: string; state: GraphRunState }): ArenaDecision | undefined | Promise<ArenaDecision | undefined>;
}

export type DoneCheckResult = { ok: true; summary?: string } | { ok: false; next: Next };

export interface ReconcileQueries {
  list_workers?: {
    ok: boolean;
    complete?: boolean;
    errorCode?: string;
    team_id?: string;
    workers?: Array<{
      label: string;
      worker_id?: string;
      worker_session_id?: string;
      status?: string;
    }>;
  };
  get_worker_queue_status?: {
    ok: boolean;
    pending?: unknown[];
    consuming?: unknown;
    errorCode?: string;
  };
  getRun?: {
    ok: boolean;
    complete?: boolean;
    run_id?: string;
    status?: string;
    errorCode?: string;
  };
  readMessages?: {
    ok: boolean;
    complete?: boolean;
    errorCode?: string;
  };
}

export type AdvanceEvent =
  | { type: "tick" }
  | { type: "wait_done"; on?: Extract<EdgeOn, "ok" | "fail" | "conflict" | "threads" | "ci_red" | "head_moved"> }
  | {
      type: "report";
      phase: "setup" | "accepted" | "reconcile" | "recover" | "final";
      dispatch_key?: string;
      outcome?: Record<string, unknown>;
      worker_id?: string;
      worker_session_id?: string;
      dispatch_outcome?: {
        created?: boolean;
        delivered?: boolean;
        queued?: boolean;
        errorCode?: string;
      };
      queued_message_id?: string;
      queries_result?: ReconcileQueries;
      action?: RecoverAction;
      action_result?: Record<string, unknown>;
      report_path?: string;
      inline_report?: { status: "done" | "partial" | "blocked" | "failed"; fingerprint?: string; summary?: string };
      report?: NodeReportSnap;
      verdict?: GraphRunState["verdict"];
      session_id?: string;
      task_id?: string;
      revision?: string;
      task_run_id?: string;
      start_sha?: string;
    };

export interface AdvanceOpts {
  spec?: GraphSpec;
  gates?: GateHooks;
  config?: RuntimeConfig;
  models?: readonly AgentModel[];
  doneCheck?: (state: GraphRunState) => DoneCheckResult | Promise<DoneCheckResult>;
}

export interface AdvanceResult {
  next: Next;
  state: GraphRunState;
}

const AFTER_REPORT = "keel_report";
const AFTER_SETUP = "keel_report phase=setup";
const AFTER_RECONCILE = "keel_report phase=reconcile";
const AFTER_RECOVER = "keel_report phase=recover";

export function classifyRetry(errorMode: ErrorMode | undefined, consecutiveFailures: number): { decision: RetryDecision; note: string } {
  if (consecutiveFailures >= 2) return { decision: "human", note: "连续 2 次失败，放弃该节点" };
  if (errorMode === "too_long" || errorMode === "over_budget") return { decision: "retry", note: "缩小范围后重试" };
  if (errorMode === "network") return { decision: "retry", note: "原样重试" };
  if (errorMode === "tool_error") return { decision: "retry", note: "换模型（备路线）" };
  if (consecutiveFailures < 1) return { decision: "retry", note: "未知错误，重试 1 次" };
  return { decision: "human", note: "未知错误已重试过，开人工门" };
}

export async function digest10(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 10);
}

export async function workerLabel(nodeId: string, key: string): Promise<string> {
  const prefix = nodeId.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 8) || "node";
  const label = `keel-${prefix}-${await digest10(key)}`;
  return label.replace(/[^a-z0-9_-]/g, "-").slice(0, 32);
}

function specOf(state: GraphRunState, opts?: AdvanceOpts): GraphSpec {
  if (opts?.spec) return opts.spec;
  const g = PSTACK_GRAPHS[state.spec_id as keyof typeof PSTACK_GRAPHS];
  if (!g) throw new KeelError("INVALID_INPUT", `未知 spec_id ${state.spec_id}`);
  return g;
}

function nodeById(spec: GraphSpec, id: string): GraphNode {
  const n = spec.nodes.find((x) => x.id === id);
  if (!n) throw new KeelError("INVALID_INPUT", `图中没有节点 ${id}`);
  return n;
}

function edgeOn(spec: GraphSpec, from: string, on: EdgeOn): string | undefined {
  return spec.edges.find((e) => e.from === from && e.on === on)?.to;
}

function whenOk(node: GraphNode, state: GraphRunState): boolean {
  const w = node.when;
  if (!w || w.kind === "always") return true;
  if (w.kind === "crosses_function_boundary") return state.facts?.crosses_function_boundary === true;
  if (w.kind === "design_contested") return state.facts?.design_contested === true;
  if (w.kind === "fingerprint_repeat") return state.fingerprints.some((f) => f.count >= w.times);
  return true;
}

function bumpFingerprint(state: GraphRunState, nodeId: string, signature: string): number {
  const row = state.fingerprints.find((f) => f.node === nodeId && f.signature === signature);
  if (row) {
    row.count += 1;
    return row.count;
  }
  state.fingerprints.push({ node: nodeId, signature, count: 1 });
  return 1;
}

function modelsAllow(models: readonly AgentModel[] | undefined, route: Route): boolean {
  if (!models || models.length === 0) return true;
  return models.some((m) => m.id === route.model && m.agent === route.agent && m.providerId === route.provider_id);
}

function pickRoute(
  manual: ModelManual,
  state: GraphRunState,
  role: Role,
  writes: boolean,
  models: readonly AgentModel[] | undefined,
  preferFallback: boolean,
): { route: Route; fallbacks: readonly Route[]; index: number; note?: string } | { stop: string } {
  const resolved = resolve(manual, state.profile_id, state.task_type, role);
  const chain = [resolved.primary, ...resolved.fallbacks];
  const skipFam = !writes && role === "verifier" ? new Set(state.author_families) : null;
  const start = preferFallback ? 1 : 0;
  for (let i = start; i < chain.length; i++) {
    const route = chain[i]!;
    if (!modelsAllow(models, route)) continue;
    if (skipFam) {
      const fam = family(route.model);
      if (!fam || skipFam.has(fam)) continue;
    }
    const note = i > 0 ? `主路线 ${chain[0]!.model} 不可用，改用 ${route.model}` : undefined;
    return { route, fallbacks: resolved.fallbacks, index: i, note };
  }
  if (skipFam && skipFam.size) return { stop: "没有与作者不同族的验证路线" };
  return { stop: "全部路线不可用" };
}

function brief(state: GraphRunState, node: GraphNode, dispatchKeyValue: string, attempt: number): string {
  return buildBrief(
    { id: node.id, role: node.role, writes: node.writes, timebox_min: node.timebox_min, inline_report: state.task_type === "investigation" },
    { run_id: state.run_id, goal: state.goal, sc: state.sc, worktree: state.worktree, repo: state.gh_repo ?? state.repo, pr: state.pr, taskType: state.task_type },
    { attempt, dispatch_key: dispatchKeyValue, ...(state.scopeAllow ? { scopeAllow: state.scopeAllow } : {}) },
  );
}

async function planOrca(
  state: GraphRunState,
  specNode: GraphNode,
  node: ReturnType<typeof ensureNode>,
  manual: ModelManual,
  models: readonly AgentModel[] | undefined,
  preferFallback: boolean,
  now: number,
): Promise<Next> {
  const role = (specNode.role ?? "worker") as Role;
  const picked = pickRoute(manual, state, role, specNode.writes, models, preferFallback);
  if ("stop" in picked) {
    state.status = "stopped";
    const next: Next = { kind: "stop", reason: picked.stop, needs_user: [picked.stop] };
    state.next = next;
    return next;
  }
  if (hasLiveWriter(specNode, node) && node.dispatch_key) {
    return requestWriterStop(state, node, node.dispatch_key, "retry", now);
  }
  if (node.attempts >= specNode.max_attempts) {
    return nextDecide(state, `human:${specNode.id}`, `节点 ${specNode.id} 已达 max_attempts`, ["stop"], true);
  }
  node.attempts += 1;
  const key = dispatchKey(state.run_id, specNode.id, node.attempts);
  const label = await workerLabel(specNode.id, key);
  const params: PlannedParams = {
    label,
    role: keelRoleFor(specNode.role),
    agent: picked.route.agent,
    model: picked.route.model,
    provider_id: picked.route.provider_id,
    effort: picked.route.effort,
    working_dir: specNode.writes || specNode.role !== "researcher" ? state.worktree : undefined,
    initial_task: brief(state, specNode, key, node.attempts),
    writes: specNode.writes,
    fallbacks: picked.fallbacks,
    route_index: picked.index,
    ...(state.scopeAllow?.length ? { scopeAllow: state.scopeAllow } : {}),
  };
  node.status = "active";
  node.dispatch_key = key;
  node.dispatch_state = "planned";
  node.dispatch_state_at = now;
  node.planned_params = params;
  node.worker_label = label;
  node.expected_recover_action = undefined;
  node.team_id = state.team?.team_id;
  node.writer_stopped = false;
  const create_worker: CreateWorkerParams = {
    label: params.label,
    role: params.role,
    agent: params.agent,
    model: params.model,
    provider_id: params.provider_id,
    effort: params.effort,
    working_dir: params.working_dir,
    initial_task: params.initial_task,
  };
  const next: Next = { kind: "dispatch", dispatch_key: key, create_worker, after: AFTER_REPORT, ...(picked.note ? { note: picked.note } : {}) };
  state.status = "running";
  state.next = next;
  return next;
}

function planPlugin(state: GraphRunState, specNode: GraphNode, node: ReturnType<typeof ensureNode>, manual: ModelManual, now: number): Next {
  const role = (specNode.role ?? "researcher") as Role;
  const resolved = resolve(manual, state.profile_id, state.task_type, role);
  if (node.attempts >= specNode.max_attempts) {
    return nextDecide(state, `human:${specNode.id}`, `节点 ${specNode.id} 已达 max_attempts`, ["stop"], true);
  }
  node.attempts += 1;
  const key = dispatchKey(state.run_id, specNode.id, node.attempts);
  const createKey = `create:${key}`;
  const body = {
    agentKind: resolved.primary.agent,
    providerId: resolved.primary.provider_id,
    model: resolved.primary.model,
    effort: resolved.primary.effort,
    isolatedWorkspace: true,
  };
  node.status = "active";
  node.dispatch_key = key;
  node.dispatch_state = "planned";
  node.dispatch_state_at = now;
  node.task = { create_request_key: createKey, create_body: body, phase: "create" };
  const next: Next = {
    kind: "dispatch",
    dispatch_key: key,
    plugin_task: { phase: "create", request_key: createKey, body },
    after: AFTER_REPORT,
  };
  state.status = "running";
  state.next = next;
  return next;
}

function nextWait(state: GraphRunState): Next {
  if (state.cursor === "open-pr") {
    const next: Next = {
      kind: "wait",
      call: {
        tool: "pr_open",
        args: {
          repo_dir: state.worktree ?? state.invocation_dir ?? "",
          ...(state.goal ? { title: state.goal.slice(0, 72) } : {}),
          ...(state.pr_binding?.base_ref ? { base: state.pr_binding.base_ref } : {}),
        },
      },
      note: "主控先调用 pr_open（authorization_source 由主控按用户授权填写），再调用 keel_wait。",
      after: "keel_wait",
    };
    state.next = next;
    return next;
  }
  const next: Next = { kind: "wait", call: { tool: "keel_wait", args: { run_id: state.run_id, max_minutes: 15 } } };
  state.next = next;
  return next;
}

function nextSetup(state: GraphRunState): Next {
  const next: Next = {
    kind: "setup",
    call: { tool: "start_team", args: { worker_permission_mode: "bypassPermissions" } },
    after: AFTER_SETUP,
  };
  state.status = "running";
  state.next = next;
  return next;
}

function emitReconcile(state: GraphRunState, node: ReturnType<typeof ensureNode>, key: string, now: number): Next {
  node.dispatch_state = "reconciling";
  node.dispatch_state_at = now;
  const queries: Array<
    | { tool: "list_workers"; team_id?: string }
    | { tool: "get_worker_queue_status"; worker_id: string }
    | { tool: "getRun"; run_id?: string; request_key?: string }
    | { tool: "readMessages"; task_id?: string }
  > = [];
  if (node.task) {
    queries.push({
      tool: "getRun",
      ...(node.task.run_id ? { run_id: node.task.run_id } : {}),
      request_key: node.task.send_request_key ?? node.task.create_request_key,
    });
    if (node.task.task_id) queries.push({ tool: "readMessages", task_id: node.task.task_id });
  } else {
    queries.push({ tool: "list_workers", ...(node.team_id ? { team_id: node.team_id } : {}) });
    if (node.worker_id) queries.push({ tool: "get_worker_queue_status", worker_id: node.worker_id });
  }
  const next: Next = { kind: "reconcile", dispatch_key: key, queries, after: AFTER_RECONCILE };
  state.status = "running";
  state.next = next;
  return next;
}

function beginReconcile(state: GraphRunState, node: ReturnType<typeof ensureNode>, key: string, now: number): Next {
  node.reconcile_rounds = (node.reconcile_rounds ?? 0) + 1;
  if (node.reconcile_rounds > MAX_RECONCILE_ROUNDS) {
    return nextDecide(state, "human:reconcile", "对账超过 3 轮仍不确定", ["retry_reconcile", "stop"], true, { rounds: node.reconcile_rounds });
  }
  return emitReconcile(state, node, key, now);
}

function nextRecover(state: GraphRunState, node: ReturnType<typeof ensureNode>, key: string, action: RecoverAction, tool: string, args: Record<string, unknown>, now: number): Next {
  node.expected_recover_action = action;
  node.dispatch_state_at = now;
  const next: Next = { kind: "recover", dispatch_key: key, action, call: { tool, args }, after: AFTER_RECOVER };
  state.status = "running";
  state.next = next;
  return next;
}

function hasLiveWriter(specNode: GraphNode, node: NodeRunState): boolean {
  if (!specNode.writes) return false;
  if (node.writer_stopped) return false;
  if (!node.dispatch_state || node.dispatch_state === "terminal") return false;
  return true;
}

function clearlyStoppedStatus(status: string | undefined): boolean {
  if (!status) return false;
  if (status === "archived") return false;
  return status === "idle" || status === "stopped" || status === "offline";
}

function isVerifiedStopped(result: Record<string, unknown>, node: NodeRunState): boolean {
  if (result.ok !== true) return false;
  if (result.complete !== true) return false;
  // A list from another team (or with no team) says nothing about the original writer.
  if (!node.team_id || result.team_id !== node.team_id) return false;
  if (result.status === "archived") return false;
  const workers = result.workers;
  if (Array.isArray(workers)) {
    const hit = workers.find((w) => {
      if (!w || typeof w !== "object") return false;
      const rec = w as { label?: string; worker_id?: string; status?: string };
      return rec.label === node.worker_label || (node.worker_id !== undefined && rec.worker_id === node.worker_id);
    }) as { status?: string } | undefined;
    if (!hit) return true;
    return clearlyStoppedStatus(hit.status);
  }
  if (result.stopped === true) return true;
  return clearlyStoppedStatus(typeof result.status === "string" ? result.status : undefined);
}

function requestWriterStop(state: GraphRunState, node: NodeRunState, key: string, after: "retry" | "escalate" | "stop" | "fail", now: number, fingerprint?: string): Next {
  node.pending_after_stop = after;
  if (fingerprint !== undefined) node.pending_fail_fingerprint = fingerprint;
  if (node.expected_recover_action === "archive" || node.expected_recover_action === "verify_stopped") {
    return state.next ?? nextRecover(state, node, key, "archive", "archive_worker", { worker_id: node.worker_id }, now);
  }
  return nextRecover(state, node, key, "archive", "archive_worker", { worker_id: node.worker_id }, now);
}

function nextDecide(state: GraphRunState, gateId: string, question: string, options: string[], human: boolean, context?: unknown): Next {
  const next: Next = { kind: "decide", gate_id: gateId, question, options, ...(context !== undefined ? { context } : {}) };
  state.status = human ? "waiting_human" : "await_sol";
  if (human) state.human_inputs += 1;
  state.next = next;
  return next;
}

function nextStop(state: GraphRunState, reason: string, needs: string[] = []): Next {
  state.status = "stopped";
  const next: Next = { kind: "stop", reason, needs_user: needs };
  state.next = next;
  return next;
}

function nextDone(state: GraphRunState, summary: string): Next {
  state.status = "done";
  const gh = state.pr_binding?.repo ?? state.gh_repo;
  const pr_url = state.pr_binding && gh ? `https://github.com/${gh}/pull/${state.pr_binding.number}` : undefined;
  const next: Next = { kind: "done", summary, ...(pr_url ? { pr_url } : {}), ...(state.verdict ? { verdict: state.verdict } : {}) };
  state.next = next;
  return next;
}

function succeed(state: GraphRunState, spec: GraphSpec, nodeId: string, now: number, on: EdgeOn = "ok"): void {
  const node = ensureNode(state, nodeId);
  node.status = "succeeded";
  node.dispatch_state = "terminal";
  node.ended_at = now;
  const to = edgeOn(spec, nodeId, on) ?? edgeOn(spec, nodeId, "ok");
  if (to) state.cursor = to;
}

function failNode(state: GraphRunState, spec: GraphSpec, nodeId: string, now: number, fingerprint?: string): void {
  const specNode = spec.nodes.find((n) => n.id === nodeId);
  const node = ensureNode(state, nodeId);
  if (specNode && hasLiveWriter(specNode, node) && node.dispatch_key) {
    requestWriterStop(state, node, node.dispatch_key, "fail", now, fingerprint);
    return;
  }
  node.status = "failed";
  node.dispatch_state = "terminal";
  node.ended_at = now;
  node.consecutive_failures = (node.consecutive_failures ?? 0) + 1;
  let on: EdgeOn = "fail";
  if (fingerprint) {
    const n = bumpFingerprint(state, nodeId, fingerprint);
    if (n >= 2 && edgeOn(spec, nodeId, "fingerprint_repeat")) on = "fingerprint_repeat";
  }
  const to = edgeOn(spec, nodeId, on) ?? edgeOn(spec, nodeId, "fail");
  if (to) state.cursor = to;
  else state.cursor = spec.exits.includes("stopped") ? "stopped" : state.cursor;
}

function findNodeByDispatchKey(state: GraphRunState, key: string): { id: string; node: ReturnType<typeof ensureNode> } | undefined {
  for (const [id, node] of Object.entries(state.nodes)) {
    if (node.dispatch_key === key) return { id, node };
  }
  return undefined;
}

function isCurrentAttempt(node: ReturnType<typeof ensureNode>, key: string): boolean {
  return node.dispatch_key === key;
}

function setupOutcomeCode(outcome: Record<string, unknown> | undefined): string | undefined {
  if (!outcome) return undefined;
  const code = outcome.errorCode ?? outcome.error_code ?? outcome.code;
  return typeof code === "string" ? code : undefined;
}

function setupMode(outcome: Record<string, unknown> | undefined): string | undefined {
  if (!outcome) return undefined;
  const mode = outcome.worker_permission_mode ?? outcome.mode;
  return typeof mode === "string" ? mode : undefined;
}

function hasInflightWriter(state: GraphRunState, spec: GraphSpec): boolean {
  for (const [id, node] of Object.entries(state.nodes)) {
    const sn = spec.nodes.find((n) => n.id === id);
    if (sn && hasLiveWriter(sn, node)) return true;
  }
  return false;
}

function applySetup(state: GraphRunState, spec: GraphSpec, event: Extract<AdvanceEvent, { type: "report" }>, now: number): void {
  const code = setupOutcomeCode(event.outcome);
  if (code === "WORKER_CANNOT_NEST") {
    nextStop(state, "当前会话是 worker，不能当主控", ["换主控会话"]);
    return;
  }
  if (code === "USER_CANCELLED" || code === "CONFIRM_TIMEOUT") {
    nextDecide(state, "human:setup", "团队初始化未完成", ["retry_setup", "stop"], true, { code });
    return;
  }
  const mode = setupMode(event.outcome);
  if (mode !== "bypassPermissions") {
    nextDecide(state, "human:setup", "团队权限不是 bypassPermissions", ["retry_setup", "stop"], true, { mode });
    return;
  }
  const teamId = event.outcome && typeof event.outcome.team_id === "string" && event.outcome.team_id ? event.outcome.team_id : undefined;
  const session = event.session_id ?? state.sol_session_id;
  // Without a team id no later query can be tied to this team, so stopping a writer could never be proven.
  if (!teamId) {
    nextDecide(state, "human:setup", "团队初始化回执没有 team_id（可用 start_team 回执或 get_workspace_info.workflow.workflow_id；workflow 为 null 则没有团队），无法绑定团队", ["retry_setup", "stop"], true);
    return;
  }
  if (state.team?.ready && hasInflightWriter(state, spec)) {
    state.prior_teams = [...(state.prior_teams ?? []), state.team];
  }
  state.team = { ready: true, mode, team_id: teamId, lead_session_id: session, checked_at: now };
  state.sol_session_id = session;
  state.status = "running";
}

function applyAccepted(state: GraphRunState, spec: GraphSpec, event: Extract<AdvanceEvent, { type: "report" }>, now: number): void {
  const key = event.dispatch_key;
  if (!key) throw new KeelError("DISPATCH_KEY_UNKNOWN", "accepted 缺少 dispatch_key");
  const parsed = parseDispatchKey(key);
  const found = findNodeByDispatchKey(state, key);
  if (!found) {
    if (parsed && state.nodes[parsed.nodeId] && state.nodes[parsed.nodeId]!.dispatch_key !== key) {
      const n = state.nodes[parsed.nodeId]!;
      n.late_reports = (n.late_reports ?? 0) + 1;
      state.late_reports.push({ dispatch_key: key, at: now });
      return;
    }
    throw new KeelError("DISPATCH_KEY_UNKNOWN", `未知 dispatch_key ${key}`);
  }
  const { id, node } = found;
  if (!isCurrentAttempt(node, key)) {
    node.late_reports = (node.late_reports ?? 0) + 1;
    state.late_reports.push({ dispatch_key: key, at: now });
    return;
  }
  const err = event.dispatch_outcome?.errorCode;
  if (err === "NOT_FOUND") {
    if (state.team?.ready) state.prior_teams = [...(state.prior_teams ?? []), state.team];
    state.team = { ready: false };
    node.dispatch_state = "planned";
    node.dispatch_state_at = now;
    return;
  }
  if (err === "DUPLICATE_LABEL") {
    beginReconcile(state, node, key, now);
    return;
  }
  const specNode = nodeById(spec, id);
  if (specNode.kind === "plugin_task") {
    const task = node.task;
    if (!task) throw new KeelError("REPORT_INVALID", "plugin_task 缺少 task 记录");
    if (task.phase === "create") {
      if (!event.task_id) {
        beginReconcile(state, node, key, now);
        return;
      }
      task.task_id = event.task_id;
      task.revision = event.revision;
      task.phase = "send";
      task.send_request_key = `send:${key}`;
      task.send_text = brief(state, specNode, key, node.attempts);
      task.expected_revision = event.revision;
      node.dispatch_state = "planned";
      node.dispatch_state_at = now;
      return;
    }
    if (!event.task_run_id) {
      beginReconcile(state, node, key, now);
      return;
    }
    task.run_id = event.task_run_id;
    node.dispatch_state = "running";
    node.dispatch_state_at = now;
    node.started_at = now;
    return;
  }
  if (node.planned_params) node.actual_route = {
    agent: node.planned_params.agent as Route["agent"],
    model: node.planned_params.model,
    provider_id: node.planned_params.provider_id,
    effort: node.planned_params.effort,
  };
  if (node.actual_route && specNode.writes) {
    const fam = family(node.actual_route.model);
    if (fam && !state.author_families.includes(fam)) state.author_families.push(fam);
  }
  if (event.start_sha) node.start_sha = event.start_sha;
  node.worker_id = event.worker_id ?? node.worker_id;
  node.worker_session_id = event.worker_session_id ?? node.worker_session_id;
  node.queued_message_id = event.queued_message_id ?? node.queued_message_id;
  const delivered = event.dispatch_outcome?.delivered === true && event.dispatch_outcome?.queued !== true;
  const queued = event.dispatch_outcome?.queued === true || Boolean(event.queued_message_id);
  if (!event.dispatch_outcome && !event.worker_id) {
    beginReconcile(state, node, key, now);
    return;
  }
  node.dispatch_state = "accepted";
  node.dispatch_state_at = now;
  if (delivered && !queued) {
    node.dispatch_state = "running";
    node.started_at = now;
  }
}

function applyReconcile(state: GraphRunState, event: Extract<AdvanceEvent, { type: "report" }>, now: number): void {
  const key = event.dispatch_key;
  if (!key) throw new KeelError("DISPATCH_KEY_UNKNOWN", "reconcile 缺少 dispatch_key");
  const found = findNodeByDispatchKey(state, key);
  if (!found) throw new KeelError("DISPATCH_KEY_UNKNOWN", `未知 dispatch_key ${key}`);
  const { node } = found;
  if (!isCurrentAttempt(node, key)) {
    state.late_reports.push({ dispatch_key: key, at: now });
    return;
  }
  const q = event.queries_result ?? {};
  if (node.task) {
    const run = q.getRun;
    const msgs = q.readMessages;
    const complete = (run?.ok === true && run.complete === true) || (msgs?.ok === true && msgs.complete === true);
    if (!complete) {
      if ((node.reconcile_rounds ?? 0) >= MAX_RECONCILE_ROUNDS) {
        nextDecide(state, "human:reconcile", "插件任务对账仍不确定", ["retry_reconcile", "stop"], true, { rounds: node.reconcile_rounds });
        return;
      }
      beginReconcile(state, node, key, now);
      return;
    }
    if (run?.status === "running" || run?.status === "completed") {
      node.dispatch_state = "running";
      node.started_at = node.started_at ?? now;
      return;
    }
    nextDecide(state, "human:reconcile", "插件任务回执缺失且查询无法确认", ["stop"], true);
    return;
  }
  const list = q.list_workers;
  if (!list || !list.ok || list.complete !== true) {
    if ((node.reconcile_rounds ?? 0) >= MAX_RECONCILE_ROUNDS) {
      nextDecide(state, "human:reconcile", "对账仍不确定", ["retry_reconcile", "stop"], true, { rounds: node.reconcile_rounds });
      return;
    }
    beginReconcile(state, node, key, now);
    return;
  }
  if (node.team_id && list.team_id !== node.team_id) {
    nextDecide(state, "human:team", "对账结果不属于原团队，不能证明旧 worker 不存在", ["stop"], true, { expected: node.team_id, got: list.team_id });
    return;
  }
  const label = node.worker_label;
  const hit = (list.workers ?? []).find((w) => w.label === label);
  if (!hit) {
    if (node.team_id && state.team?.team_id && node.team_id !== state.team.team_id && !node.writer_stopped) {
      nextDecide(state, "human:team", "主控或团队已变，旧写入者状态未知，不能重派", ["stop"], true);
      return;
    }
    node.dispatch_state = "planned";
    node.dispatch_state_at = now;
    return;
  }
  node.worker_id = hit.worker_id ?? node.worker_id;
  if (!hit.worker_session_id && !node.worker_session_id) {
    if ((node.reconcile_rounds ?? 0) >= MAX_RECONCILE_ROUNDS) {
      nextDecide(state, "human:reconcile", "查到 worker 但没有会话 id", ["retry_reconcile", "stop"], true);
      return;
    }
    beginReconcile(state, node, key, now);
    return;
  }
  node.worker_session_id = hit.worker_session_id ?? node.worker_session_id;
  const queue = q.get_worker_queue_status;
  const workerBusy = hit.status === "running" || hit.status === "busy";
  if (workerBusy || queue === undefined) {
    node.dispatch_state = workerBusy ? "running" : "accepted";
    if (workerBusy) node.started_at = node.started_at ?? now;
    node.dispatch_state_at = now;
    return;
  }
  if (!queue.ok) {
    beginReconcile(state, node, key, now);
    return;
  }
  const pending = queue.pending?.length ?? 0;
  const consuming = queue.consuming != null && queue.consuming !== false;
  if (pending > 0 || consuming) {
    node.dispatch_state = "accepted";
    node.dispatch_state_at = now;
    node.queued_message_id = node.queued_message_id ?? "queued";
    return;
  }
  if (node.send_initial_attempted) {
    nextDecide(state, "human:send_initial", "补投结果未知，不能再发", ["stop"], true);
    return;
  }
  // Idle with an empty queue looks the same whether the task was never accepted or already
  // finished; Orca gives no history to tell them apart, so never resend automatically.
  if (hit.status === "idle" && !node.started_at && node.dispatch_state !== "running") {
    nextDecide(state, "human:reconcile", "worker 空闲且队列为空：无法区分“从未受理”和“已经做完”，不自动补投，请查看该 worker 的输出", ["retry_reconcile", "stop"], true, { worker_id: node.worker_id });
    return;
  }
  if (hit.status === "idle") {
    node.dispatch_state = "accepted";
    node.dispatch_state_at = now;
    return;
  }
  nextDecide(state, "human:reconcile", "worker 状态无法确认，不补投", ["stop"], true, { status: hit.status });
}

async function applyRecover(state: GraphRunState, spec: GraphSpec, event: Extract<AdvanceEvent, { type: "report" }>, gates: GateHooks | undefined, now: number): Promise<void> {
  const key = event.dispatch_key;
  if (!key) throw new KeelError("DISPATCH_KEY_UNKNOWN", "recover 缺少 dispatch_key");
  const found = findNodeByDispatchKey(state, key);
  if (!found) throw new KeelError("DISPATCH_KEY_UNKNOWN", `未知 dispatch_key ${key}`);
  const { id, node } = found;
  if (!node.expected_recover_action || event.action !== node.expected_recover_action) {
    throw new KeelError("RECOVER_ACTION_MISMATCH", `回报的动作 ${event.action ?? "(缺)"} 不是 next 要求的 ${node.expected_recover_action ?? "(无)"}`);
  }
  if (!isCurrentAttempt(node, key)) {
    state.late_reports.push({ dispatch_key: key, at: now });
    return;
  }
  const action = node.expected_recover_action;
  const result = event.action_result ?? {};
  if (action === "send_initial") {
    node.expected_recover_action = undefined;
    if (result.ok === false || result.errorCode) {
      nextDecide(state, "human:send_initial", "补投失败或结果未知，不能再发", ["stop"], true, { result });
      return;
    }
    node.dispatch_state = "running";
    node.started_at = now;
    return;
  }
  if (action === "diagnose") {
    node.expected_recover_action = undefined;
    const still = result.status === "running" || result.running === true;
    const specNode = nodeById(spec, id);
    const classified = classifyRetry(node.error_mode ?? (still ? "too_long" : "unknown"), node.consecutive_failures ?? 0);
    const hooked = await Promise.resolve(gates?.retry?.({ node: id, error_mode: node.error_mode, consecutive_failures: node.consecutive_failures ?? 0, state }));
    const decision = hooked ?? classified.decision;
    if (decision === "retry") {
      requestWriterStop(state, node, key, "retry", now);
      if (classified.note.includes("换模型")) node.error_mode = "tool_error";
      return;
    }
    if (decision === "escalate") {
      failNode(state, spec, id, now, "escalate");
      return;
    }
    if (decision === "stop") {
      const specNodeStop = nodeById(spec, id);
      if (hasLiveWriter(specNodeStop, node) && node.dispatch_key) {
        requestWriterStop(state, node, key, "stop", now);
        return;
      }
      failNode(state, spec, id, now);
      state.cursor = "stopped";
      return;
    }
    nextDecide(state, `g-retry:${id}`, `节点 ${id} 超时或失败，如何处理？`, ["retry", "escalate", "stop"], true, { still, spec: specNode.id });
    return;
  }
  if (action === "archive") {
    node.archived = result.ok === true;
    node.expected_recover_action = undefined;
    nextRecover(state, node, key, "verify_stopped", "worker_status", { worker_id: node.worker_id }, now);
    return;
  }
  if (action === "verify_stopped") {
    const confirmed = isVerifiedStopped(result, node);
    node.expected_recover_action = undefined;
    if (!confirmed) {
      nextDecide(state, "human:verify_stopped", "归档后无法确认旧执行已停止，不能开新 attempt", ["retry_verify", "stop"], true, { result });
      return;
    }
    node.writer_stopped = true;
    const pending = node.pending_after_stop;
    const fingerprint = node.pending_fail_fingerprint;
    node.pending_after_stop = undefined;
    node.pending_fail_fingerprint = undefined;
    node.dispatch_state = "terminal";
    node.status = "failed";
    node.ended_at = now;
    node.consecutive_failures = (node.consecutive_failures ?? 0) + 1;
    const oldKey = node.dispatch_key;
    node.dispatch_key = undefined;
    node.worker_id = undefined;
    node.worker_session_id = undefined;
    node.queued_message_id = undefined;
    node.send_initial_attempted = false;
    node.archived = true;
    if (pending === "stop") {
      state.cursor = "stopped";
      return;
    }
    if (pending === "escalate" || pending === "fail") {
      failNode(state, spec, id, now, fingerprint ?? (pending === "escalate" ? "escalate" : undefined));
      return;
    }
    if (pending === "retry") {
      node.status = "failed";
      return;
    }
    void oldKey;
    return;
  }
}

function applyFinal(state: GraphRunState, spec: GraphSpec, event: Extract<AdvanceEvent, { type: "report" }>, now: number): void {
  const key = event.dispatch_key;
  if (!key) throw new KeelError("DISPATCH_KEY_UNKNOWN", "final 缺少 dispatch_key");
  const parsed = parseDispatchKey(key);
  const found = findNodeByDispatchKey(state, key);
  if (!found) {
    if (parsed && state.nodes[parsed.nodeId] && state.nodes[parsed.nodeId]!.dispatch_key !== key) {
      state.nodes[parsed.nodeId]!.late_reports = (state.nodes[parsed.nodeId]!.late_reports ?? 0) + 1;
      state.late_reports.push({ dispatch_key: key, at: now });
      return;
    }
    throw new KeelError("DISPATCH_KEY_UNKNOWN", `未知 dispatch_key ${key}`);
  }
  const { id, node } = found;
  if (!isCurrentAttempt(node, key)) {
    node.late_reports = (node.late_reports ?? 0) + 1;
    state.late_reports.push({ dispatch_key: key, at: now });
    return;
  }
  node.dispatch_state = "reported";
  node.report_path = event.report_path;
  if (event.report) node.last_report = { ...event.report, fresh: true };
  if (event.verdict) state.verdict = event.verdict;
  const status = event.inline_report?.status ?? event.report?.status ?? "done";
  if (status === "done" || status === "partial") succeed(state, spec, id, now);
  else failNode(state, spec, id, now, event.inline_report?.fingerprint);
}

async function applyEvent(state: GraphRunState, spec: GraphSpec, event: AdvanceEvent, gates: GateHooks | undefined, now: number): Promise<void> {
  if (event.type === "tick") return;
  if (event.type === "wait_done") {
    const id = state.cursor;
    const on = event.on ?? "ok";
    if (on === "fail") failNode(state, spec, id, now);
    else succeed(state, spec, id, now, on);
    return;
  }
  if (event.phase === "setup") return applySetup(state, spec, event, now);
  if (event.phase === "accepted") return applyAccepted(state, spec, event, now);
  if (event.phase === "reconcile") return applyReconcile(state, event, now);
  if (event.phase === "recover") return applyRecover(state, spec, event, gates, now);
  if (event.phase === "final") return applyFinal(state, spec, event, now);
}

/** Consume a keel_gate answer that matches the current decide next. Leaves computeNext's early-return for unanswered decide. */
function applyGateAnswer(state: GraphRunState, spec: GraphSpec, now: number): void {
  if (state.next?.kind !== "decide") return;
  if (state.status !== "await_sol" && state.status !== "waiting_human") return;
  const gid = state.next.gate_id;
  const i = state.sol_decisions.findIndex((d) => d.gate_id === gid);
  if (i < 0) return;
  const answer = state.sol_decisions[i]!.answer;
  state.sol_decisions.splice(i, 1);
  if (answer === "stop") {
    nextStop(state, "主控选择停止");
    return;
  }
  state.status = "running";
  if (gid.startsWith("human:")) {
    const nodeId = gid.slice("human:".length);
    if (spec.nodes.some((n) => n.id === nodeId)) {
      if (answer === "fail") failNode(state, spec, nodeId, now);
      else succeed(state, spec, nodeId, now);
    }
    state.next = undefined;
    return;
  }
  const specNode = spec.nodes.find((n) => n.id === gid);
  if (specNode?.kind === "gate") {
    const to = edgeOn(spec, gid, `gate:${answer}`);
    if (!to) {
      nextDecide(state, gid, `门 ${gid} 选项 ${answer} 没有边`, [answer], false);
      return;
    }
    const node = ensureNode(state, gid);
    node.status = "succeeded";
    node.ended_at = now;
    state.cursor = to;
    state.next = undefined;
    return;
  }
  state.next = undefined;
}

function applyTimeouts(state: GraphRunState, spec: GraphSpec, now: number, event: AdvanceEvent): void {
  for (const [id, node] of Object.entries(state.nodes)) {
    if (!node.dispatch_key || node.dispatch_state === "terminal" || node.dispatch_state === "reported") continue;
    const since = node.dispatch_state_at ?? node.started_at ?? 0;
    const specNode = spec.nodes.find((n) => n.id === id);
    if (node.expected_recover_action) {
      if (event.type === "tick" && node.send_initial_attempted && node.expected_recover_action === "send_initial") {
        nextDecide(state, "human:send_initial", "补投结果未知，不能再发", ["stop"], true);
        return;
      }
      if (now - since >= RECOVER_TIMEOUT_MS) {
        node.recover_timeouts = (node.recover_timeouts ?? 0) + 1;
        const action = node.expected_recover_action;
        node.expected_recover_action = undefined;
        if (node.recover_timeouts >= MAX_RECOVER_TIMEOUTS) {
          nextDecide(state, "human:recover", `恢复动作 ${action} 超时且未收到报告`, ["stop"], true, { action });
          return;
        }
        nextDecide(state, "human:recover", `恢复动作 ${action} 超时，不重发`, ["stop"], true, { action });
        return;
      }
      continue;
    }
    if (node.dispatch_state === "reconciling" && now - since >= RECONCILE_TIMEOUT_MS) {
      beginReconcile(state, node, node.dispatch_key, now);
      return;
    }
    if (node.dispatch_state === "planned" && now - since >= PLANNED_TIMEOUT_MS) {
      beginReconcile(state, node, node.dispatch_key, now);
      return;
    }
    if (node.dispatch_state === "accepted" && now - since >= ACCEPTED_TIMEOUT_MS) {
      beginReconcile(state, node, node.dispatch_key, now);
      return;
    }
    if (node.dispatch_state === "running") {
      const box = (specNode?.timebox_min ?? 30) * 60 * 1000;
      const start = node.started_at ?? since;
      if (now - start >= box) {
        node.error_mode = "too_long";
        nextRecover(state, node, node.dispatch_key, "diagnose", "worker_status", { worker_id: node.worker_id }, now);
        return;
      }
    }
  }
}

function inflight(state: GraphRunState): { id: string; node: NodeRunState } | undefined {
  for (const [id, node] of Object.entries(state.nodes)) {
    if (!node.dispatch_state) continue;
    if (node.dispatch_state === "terminal" || node.dispatch_state === "reported") continue;
    if (node.status === "succeeded" || node.status === "failed" || node.status === "skipped") continue;
    return { id, node };
  }
  return undefined;
}

function pluginSendNext(state: GraphRunState, node: NodeRunState): Next | undefined {
  const task = node.task;
  if (!task || task.phase !== "send" || !node.dispatch_key || task.run_id) return undefined;
  if (!task.send_request_key || !task.task_id) return undefined;
  const next: Next = {
    kind: "dispatch",
    dispatch_key: node.dispatch_key,
    plugin_task: {
      phase: "send",
      request_key: task.send_request_key,
      task_id: task.task_id,
      expected_revision: task.expected_revision,
      text: task.send_text,
    },
    after: AFTER_REPORT,
  };
  state.next = next;
  return next;
}

async function enter(
  state: GraphRunState,
  spec: GraphSpec,
  opts: { gates?: GateHooks; manual: ModelManual; models?: readonly AgentModel[]; preferFallback?: boolean; doneCheck?: AdvanceOpts["doneCheck"] },
  now: number,
  depth = 0,
): Promise<Next> {
  if (depth > spec.nodes.length + 2) return nextStop(state, "图推进陷入循环");
  if (state.status === "done" && state.next?.kind === "done") return state.next;
  if (state.status === "stopped" && state.next?.kind === "stop") return state.next;
  if (state.status === "waiting_human" && state.next?.kind === "decide") return state.next;
  if (state.status === "await_sol" && state.next?.kind === "decide") return state.next;

  const id = state.cursor;
  const specNode = nodeById(spec, id);
  const node = ensureNode(state, id);

  if (spec.exits.includes(id as "done" | "stopped") || specNode.id === "done" || specNode.id === "stopped") {
    if (specNode.id === "done") {
      if (opts.doneCheck) {
        const checked = await opts.doneCheck(state);
        if (!checked.ok) {
          state.next = checked.next;
          if (checked.next.kind === "decide") {
            state.status = checked.next.gate_id.startsWith("human:") ? "waiting_human" : "await_sol";
          } else {
            state.status = "running";
          }
          return checked.next;
        }
        return nextDone(state, checked.summary ?? "图到达 done");
      }
      return nextDone(state, "图到达 done");
    }
    return nextStop(state, "图到达 stopped");
  }

  if (!whenOk(specNode, state)) {
    node.status = "skipped";
    const to = edgeOn(spec, id, "ok");
    if (!to) return nextStop(state, `节点 ${id} 被跳过但没有 ok 边`);
    state.cursor = to;
    return enter(state, spec, opts, now, depth + 1);
  }

  if (specNode.kind === "gate") {
    const gateName = id.startsWith("g-retry") ? "retry" : id.startsWith("g-accept") ? "accept" : id.includes("arena") ? "arena" : "advance";
    let value: string | undefined;
    if (gateName === "retry") value = await Promise.resolve(opts.gates?.retry?.({ node: id, consecutive_failures: node.consecutive_failures ?? 0, state }));
    else if (gateName === "accept") value = await Promise.resolve(opts.gates?.accept?.({ node: id, state }));
    else if (gateName === "arena") value = await Promise.resolve(opts.gates?.arena?.({ node: id, state }));
    else value = await Promise.resolve(opts.gates?.advance?.({ node: id, state }));
    if (!value) {
      const options =
        gateName === "retry" ? ["retry", "escalate", "stop"] :
        gateName === "accept" ? ["adopt", "revise", "ask_user"] :
        gateName === "arena" ? ["single", "arena"] :
        ["advance", "stay"];
      return nextDecide(state, id, `门 ${id}`, options, false);
    }
    const to = edgeOn(spec, id, `gate:${value}`);
    if (!to) return nextDecide(state, id, `门 ${id} 选项 ${value} 没有边`, [value], false);
    node.status = "succeeded";
    state.cursor = to;
    return enter(state, spec, opts, now, depth + 1);
  }

  if (specNode.kind === "human") {
    return nextDecide(state, `human:${id}`, `人工节点 ${id}`, ["ok", "fail"], true);
  }

  if (specNode.kind === "tool") {
    if (id === "done" || id === "stopped") {
      if (id === "done") return nextDone(state, "图到达 done");
      return nextStop(state, "图到达 stopped");
    }
    // Still waiting on this entry: ticks while waiting are not new attempts.
    if (node.status === "active") return nextWait(state);
    if (node.attempts >= specNode.max_attempts) {
      const to = edgeOn(spec, id, "fail");
      if (to && to !== id) {
        failNode(state, spec, id, now);
        return enter(state, spec, opts, now, depth + 1);
      }
      return nextDecide(state, `human:${id}`, `工具节点 ${id} 已达 max_attempts`, ["stop"], true);
    }
    node.attempts += 1;
    node.status = "active";
    return nextWait(state);
  }

  if (specNode.kind === "plugin_task") {
    if (node.task?.phase === "send" && !node.task.run_id && node.dispatch_state === "planned") {
      const send = pluginSendNext(state, node);
      if (send) return send;
    }
    return planPlugin(state, specNode, node, opts.manual, now);
  }

  if (specNode.kind === "dispatch") {
    if (!state.team?.ready) return nextSetup(state);
    return planOrca(state, specNode, node, opts.manual, opts.models, opts.preferFallback === true, now);
  }

  return nextStop(state, `未知节点 kind ${specNode.kind}`);
}

function clearStaleNext(state: GraphRunState): void {
  const n = state.next;
  if (!n) return;
  if (n.kind === "setup" && state.team?.ready) state.next = undefined;
  if (n.kind === "recover") {
    const found = n.dispatch_key ? findNodeByDispatchKey(state, n.dispatch_key) : undefined;
    if (!found || found.node.expected_recover_action !== n.action) state.next = undefined;
  }
  if (n.kind === "reconcile") {
    const found = n.dispatch_key ? findNodeByDispatchKey(state, n.dispatch_key) : undefined;
    if (!found || found.node.dispatch_state !== "reconciling") state.next = undefined;
  }
}

async function computeNext(
  state: GraphRunState,
  spec: GraphSpec,
  opts: { gates?: GateHooks; manual: ModelManual; models?: readonly AgentModel[]; doneCheck?: AdvanceOpts["doneCheck"] },
  now: number,
): Promise<Next> {
  clearStaleNext(state);
  if (state.next?.kind === "stop" && state.status === "stopped") return state.next;
  if (state.next?.kind === "done" && state.status === "done") return state.next;
  if (state.next?.kind === "decide" && (state.status === "waiting_human" || state.status === "await_sol")) return state.next;
  if (state.next?.kind === "recover") return state.next;
  if (state.next?.kind === "setup" && !state.team?.ready) return state.next;
  if (state.next?.kind === "reconcile") return state.next;

  const active = inflight(state);
  if (active && active.node.team_id && state.team?.team_id && active.node.team_id !== state.team.team_id && !active.node.writer_stopped) {
    return nextDecide(state, "human:team", "主控或团队已变，旧写入者状态未知，不能重派", ["stop"], true);
  }
  if (active && !state.team?.ready && active.node.planned_params) return nextSetup(state);
  if (active) {
    const { node } = active;
    if (node.task && node.dispatch_state === "planned") {
      const send = pluginSendNext(state, node);
      if (send) return send;
      if (node.task.phase === "create") {
        const next: Next = {
          kind: "dispatch",
          dispatch_key: node.dispatch_key!,
          plugin_task: { phase: "create", request_key: node.task.create_request_key, body: node.task.create_body },
          after: AFTER_REPORT,
        };
        state.next = next;
        return next;
      }
    }
    if (node.dispatch_state === "reconciling") return emitReconcile(state, node, node.dispatch_key!, now);
    if (node.dispatch_state === "planned") {
      const send = pluginSendNext(state, node);
      if (send) return send;
      if (node.task?.phase === "create") {
        const next: Next = {
          kind: "dispatch",
          dispatch_key: node.dispatch_key!,
          plugin_task: { phase: "create", request_key: node.task.create_request_key, body: node.task.create_body },
          after: AFTER_REPORT,
        };
        state.next = next;
        return next;
      }
      if (node.planned_params) {
        const p = node.planned_params;
        const next: Next = {
          kind: "dispatch",
          dispatch_key: node.dispatch_key!,
          create_worker: {
            label: p.label,
            role: p.role,
            agent: p.agent,
            model: p.model,
            provider_id: p.provider_id,
            effort: p.effort,
            working_dir: p.working_dir,
            initial_task: p.initial_task,
          },
          after: AFTER_REPORT,
        };
        state.next = next;
        return next;
      }
    }
    if (node.dispatch_state === "accepted" || node.dispatch_state === "running") return nextWait(state);
  }

  return enter(state, spec, opts, now);
}

export async function createRun(host: Host, opts: InitRunOpts): Promise<GraphRunState> {
  return withRun(host, opts.run_id, (raw) => {
    const init = initGraphState({ ...opts, now: opts.now ?? host.now() });
    Object.assign(raw, init);
    return init;
  });
}

export async function advance(host: Host, runId: string, event: AdvanceEvent, opts: AdvanceOpts = {}): Promise<AdvanceResult> {
  return withRun(host, runId, async (raw: GraphState) => {
    const state = raw as unknown as GraphRunState;
    if (!state.spec_id || !state.cursor) throw new KeelError("RUN_STATE_INVALID", `run ${runId} 尚未初始化`);
    const spec = specOf(state, opts);
    const cfg = opts.config ?? (await loadRuntimeConfig(host));
    const models = opts.models ?? (await host.agentModels()).models;
    const now = host.now();
    await applyEvent(state, spec, event, opts.gates, now);
    applyGateAnswer(state, spec, now);
    if (state.status !== "stopped" && state.status !== "done" && state.status !== "waiting_human" && state.status !== "await_sol") {
      applyTimeouts(state, spec, now, event);
    }
    const next = await computeNext(state, spec, { gates: opts.gates, manual: cfg.manual, models, doneCheck: opts.doneCheck }, now);
    state.next = next;
    state.updated_at = now;
    return { next, state };
  });
}
