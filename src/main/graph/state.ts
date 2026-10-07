// graph-state.json: Appendix A fields plus a few interpreter-only bookkeeping keys.

import type { Harness, Route, TaskType } from "../../shared/manual/schema.ts";

export const DISPATCH_STATES = ["planned", "accepted", "running", "reported", "terminal", "reconciling"] as const;
export type DispatchState = (typeof DISPATCH_STATES)[number];

export const RUN_STATUSES = ["running", "await_sol", "waiting_human", "done", "stopped"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const KEEL_ROLES = ["keel-worker", "keel-explorer", "keel-verifier", "keel-architect"] as const;
export type KeelRole = (typeof KEEL_ROLES)[number];

export const RECOVER_ACTIONS = ["send_initial", "diagnose", "archive", "verify_stopped"] as const;
export type RecoverAction = (typeof RECOVER_ACTIONS)[number];

export type ErrorMode = "too_long" | "over_budget" | "network" | "tool_error" | "unknown";

export interface CreateWorkerParams {
  label: string;
  role: KeelRole;
  agent: string;
  model: string;
  provider_id: string;
  effort?: string;
  working_dir?: string;
  initial_task: string;
}

export interface PlannedParams extends CreateWorkerParams {
  writes: boolean;
  manual_revision?: string;
  fallbacks: readonly Route[];
  /** Index into [primary, ...fallbacks] actually chosen when planning. */
  route_index: number;
  /** Write-domain globs copied from the run / brief. Missing means no writes allowed. */
  scopeAllow?: readonly string[];
  /** Worktree HEAD at plan time. Frozen for the attempt; final scope uses it as git/changed-files base. */
  start_sha?: string;
}

export interface NodeReportSnap {
  status?: string;
  summary?: string;
  ran?: readonly { cmd: string; exit_code: number; tests_passed?: number }[];
  head_sha?: string;
  files_changed?: readonly string[];
  findings?: readonly string[];
  citation?: string;
  sc_evidence?: Readonly<Record<string, boolean>>;
  verdict?: string;
  ui_evidence?: readonly string[];
  surface?: string;
  fresh?: boolean;
  head_matches?: boolean;
}

export interface GateAnswer {
  gate_id: string;
  attempt: number;
  answer: string;
  reason?: string;
}

export interface PluginTaskRecord {
  create_request_key: string;
  create_body: Record<string, unknown>;
  task_id?: string;
  revision?: string;
  send_request_key?: string;
  send_text?: string;
  expected_revision?: string;
  run_id?: string;
  phase: "create" | "send";
  send_initial_attempted?: boolean;
}

export interface NodeRunState {
  status: "pending" | "active" | "succeeded" | "failed" | "skipped";
  attempts: number;
  dispatch_key?: string;
  dispatch_state?: DispatchState;
  dispatch_state_at?: number;
  planned_params?: PlannedParams;
  actual_route?: Route;
  worker_label?: string;
  worker_id?: string;
  worker_session_id?: string;
  queued_message_id?: string;
  reconcile_rounds?: number;
  task?: PluginTaskRecord;
  report_path?: string;
  started_at?: number;
  ended_at?: number;
  error_mode?: ErrorMode;
  consecutive_failures?: number;
  expected_recover_action?: RecoverAction;
  send_initial_attempted?: boolean;
  archived?: boolean;
  late_reports?: number;
  last_report?: NodeReportSnap;
  team_id?: string;
  /** HEAD at the start of this write attempt; final scope uses git/changed-files base=start_sha. */
  start_sha?: string;
  writer_stopped?: boolean;
  pending_after_stop?: "retry" | "escalate" | "stop" | "fail";
  pending_fail_fingerprint?: string;
  recover_timeouts?: number;
}

export interface TeamState {
  lead_session_id?: string;
  team_id?: string;
  mode?: string;
  ready: boolean;
  checked_at?: number;
}

export interface StartState {
  head?: string;
  status_digest?: string;
  content_hash?: string;
}

export interface PrBinding {
  repo: string;
  number: number;
  head_repo?: string;
  branch?: string;
  head_sha?: string;
  base_ref?: string;
  base_sha?: string;
}

export interface SuccessCriterion {
  id: string;
  text: string;
  verify?: string;
}

export interface Verdict {
  head?: string;
  base_ref?: string;
  base_sha?: string;
  patch_id?: string;
  value?: string;
  level?: string;
  surface?: string;
  by_route?: Route;
  by_family?: string;
  head_matches?: boolean;
}

export interface Fingerprint {
  node: string;
  signature: string;
  count: number;
}

export type Next =
  | { kind: "setup"; call: { tool: "start_team"; args: { worker_permission_mode: "bypassPermissions" } }; after: string }
  | {
      kind: "dispatch";
      dispatch_key: string;
      create_worker?: CreateWorkerParams;
      plugin_task?: {
        phase: "create" | "send";
        request_key: string;
        body?: Record<string, unknown>;
        task_id?: string;
        expected_revision?: string;
        text?: string;
      };
      note?: string;
      after: string;
    }
  | {
      kind: "reconcile";
      dispatch_key: string;
      queries: Array<
        | { tool: "list_workers"; team_id?: string }
        | { tool: "get_worker_queue_status"; worker_id: string }
        | { tool: "getRun"; run_id?: string; request_key?: string }
        | { tool: "readMessages"; task_id?: string }
      >;
      after: string;
    }
  | {
      kind: "recover";
      dispatch_key: string;
      action: RecoverAction;
      call: { tool: string; args: Record<string, unknown> };
      after: string;
    }
  | {
      kind: "wait";
      call:
        | { tool: "keel_wait"; args: { run_id: string; max_minutes?: number } }
        | { tool: "pr_open"; args: Record<string, unknown> };
      note?: string;
      after?: string;
    }
  | { kind: "decide"; gate_id: string; question: string; options: string[]; context?: unknown }
  | { kind: "done"; summary: string; pr_url?: string; verdict?: Verdict }
  | { kind: "stop"; reason: string; needs_user: string[] };

export interface GraphFacts {
  crosses_function_boundary?: boolean;
  design_contested?: boolean;
}

export interface GraphRunState {
  run_id: string;
  spec_id: string;
  profile_id: string;
  lead_harness: Harness;
  task_type: TaskType;
  team?: TeamState;
  prior_teams?: TeamState[];
  author_families: string[];
  start_state?: StartState;
  pr_binding?: PrBinding;
  sol_session_id?: string;
  /** User-supplied repo_dir. Investigation fingerprints are taken here. */
  invocation_dir?: string;
  /** git rev-parse --show-toplevel */
  repo_root?: string;
  /** GitHub owner/name. Never a local path. */
  gh_repo?: string;
  /** @deprecated prefer gh_repo; kept as owner/name alias. */
  repo?: string;
  worktree?: string;
  pr?: number | string;
  goal: string;
  sc: SuccessCriterion[];
  status: RunStatus;
  cursor: string;
  nodes: Record<string, NodeRunState>;
  next?: Next;
  fingerprints: Fingerprint[];
  jev: Array<{ gate: string; choice: string; confidence: number; routed: "act" | "sol" | "default"; at: number }>;
  sol_decisions: GateAnswer[];
  astra_calls: number;
  scopeAllow?: readonly string[];
  gate_cache?: Record<string, unknown>;
  budget: { astra_left: number };
  verdict?: Verdict;
  pushes: Array<{ head: string; local_at: number }>;
  nudges: { since_progress: number; last_at?: number };
  human_inputs: number;
  updated_at: number;
  facts?: GraphFacts;
  late_reports: Array<{ dispatch_key: string; at: number }>;
}

export interface InitRunOpts {
  run_id: string;
  spec_id: string;
  profile_id: string;
  lead_harness: Harness;
  task_type: TaskType;
  entry: string;
  goal: string;
  sc?: SuccessCriterion[];
  invocation_dir?: string;
  repo_root?: string;
  gh_repo?: string;
  repo?: string;
  worktree?: string;
  pr?: number | string;
  sol_session_id?: string;
  start_state?: StartState;
  pr_binding?: PrBinding;
  astra_budget?: number;
  facts?: GraphFacts;
  now?: number;
  author_families?: string[];
  scopeAllow?: readonly string[];
}


export function initGraphState(opts: InitRunOpts): GraphRunState {
  return {
    run_id: opts.run_id,
    spec_id: opts.spec_id,
    profile_id: opts.profile_id,
    lead_harness: opts.lead_harness,
    task_type: opts.task_type,
    author_families: opts.author_families ?? [],
    start_state: opts.start_state,
    pr_binding: opts.pr_binding,
    sol_session_id: opts.sol_session_id,
    invocation_dir: opts.invocation_dir,
    repo_root: opts.repo_root,
    gh_repo: opts.gh_repo,
    repo: opts.gh_repo ?? opts.repo,
    worktree: opts.worktree,
    pr: opts.pr,
    goal: opts.goal,
    sc: opts.sc ?? [],
    status: "running",
    cursor: opts.entry,
    nodes: {},
    fingerprints: [],
    jev: [],
    sol_decisions: [],
    astra_calls: 0,
    budget: { astra_left: opts.astra_budget ?? 4 },
    pushes: [],
    nudges: { since_progress: 0 },
    human_inputs: 0,
    updated_at: opts.now ?? 0,
    facts: opts.facts,
    late_reports: [],
    ...(opts.scopeAllow ? { scopeAllow: opts.scopeAllow } : {}),
  };
}

export function ensureNode(state: GraphRunState, id: string): NodeRunState {
  const existing = state.nodes[id];
  if (existing) return existing;
  const created: NodeRunState = { status: "pending", attempts: 0 };
  state.nodes[id] = created;
  return created;
}

export function dispatchKey(runId: string, nodeId: string, attempt: number): string {
  return `${runId}:${nodeId}:${attempt}`;
}

export function parseDispatchKey(key: string): { runId: string; nodeId: string; attempt: number } | null {
  const parts = key.split(":");
  if (parts.length < 3) return null;
  const attempt = Number(parts[parts.length - 1]);
  if (!Number.isInteger(attempt) || attempt < 1) return null;
  const nodeId = parts[parts.length - 2]!;
  const runId = parts.slice(0, -2).join(":");
  if (!runId || !nodeId) return null;
  return { runId, nodeId, attempt };
}

export function keelRoleFor(role: string | undefined): KeelRole {
  if (role === "explorer") return "keel-explorer";
  if (role === "verifier") return "keel-verifier";
  if (role === "architect") return "keel-architect";
  return "keel-worker";
}

export const PLANNED_TIMEOUT_MS = 2 * 60 * 1000;
export const ACCEPTED_TIMEOUT_MS = 10 * 60 * 1000;
export const RECONCILE_TIMEOUT_MS = 2 * 60 * 1000;
export const RECOVER_TIMEOUT_MS = 2 * 60 * 1000;
export const MAX_RECONCILE_ROUNDS = 3;
export const MAX_RECOVER_TIMEOUTS = 1;
