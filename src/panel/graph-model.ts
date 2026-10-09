// graph-state.json → view model. No DOM.

export const EMPTY_GRAPH_MESSAGE = "还没有编排 run。主控调用 keel_run 之后，这里会画出每个 PR 的节点、在途 worker 和门。";

export interface GraphNodeState {
  readonly status?: string;
  readonly dispatch_state?: string;
  readonly attempts?: number;
  readonly worker_label?: string;
  readonly worker_id?: string;
  readonly actual_route?: { readonly model?: string; readonly effort?: string; readonly agent?: string };
  readonly planned_params?: { readonly model?: string; readonly effort?: string };
  readonly started_at?: string;
  readonly ended_at?: string;
  readonly error_mode?: string;
}

export interface GraphState {
  readonly run_id?: string;
  readonly status?: string;
  readonly goal?: string;
  readonly repo?: string;
  readonly pr?: number | { readonly number?: number; readonly url?: string };
  readonly pr_binding?: { readonly repo?: string; readonly number?: number; readonly branch?: string; readonly head_sha?: string };
  readonly worktree?: string;
  readonly updated_at?: string;
  readonly nodes?: Readonly<Record<string, GraphNodeState>>;
  readonly next?: { readonly kind?: string };
  readonly jev?: readonly { readonly gate?: string; readonly choice?: string; readonly confidence?: number; readonly routed?: string; readonly at?: string }[];
  readonly sol_decisions?: readonly { readonly gate?: string; readonly answer?: string; readonly at?: string }[];
  readonly astra_calls?: number | readonly { readonly conclusion?: string; readonly at?: string }[];
  readonly budget?: { readonly astra_left?: number };
  readonly verdict?: { readonly head_matches?: boolean; readonly value?: string; readonly level?: string };
  readonly human_inputs?: number;
}

export interface NodeView {
  readonly id: string;
  readonly status: string;
  readonly dispatch_state: string;
  readonly current: boolean;
  readonly worker_label?: string;
  readonly model?: string;
  readonly effort?: string;
}

export interface WorkerView {
  readonly label: string;
  readonly model: string;
  readonly effort: string;
  readonly dispatch_state: string;
}

export interface JevView {
  readonly gate: string;
  readonly choice: string;
  readonly confidence: string;
  readonly routed: string;
  readonly at: string;
}

export interface GithubView {
  readonly label: string;
  readonly url?: string;
  readonly ci: string;
  readonly mergeable: string;
}

export interface RunView {
  readonly run_id: string;
  readonly status: string;
  readonly goal: string;
  readonly current_nodes: readonly string[];
  readonly nodes: readonly NodeView[];
  readonly workers: readonly WorkerView[];
  readonly jev: readonly JevView[];
  readonly sol_decisions: readonly { readonly gate: string; readonly answer: string; readonly at: string }[];
  readonly astra: { readonly calls: number; readonly left: string; readonly last: string };
  readonly elapsed: string;
  readonly human_gates: readonly string[];
  readonly github: GithubView;
}

export interface GraphViewModel {
  readonly runs: readonly RunView[];
  readonly empty: boolean;
  readonly empty_message: string;
}

export interface GraphStore {
  readonly runs: Readonly<Record<string, GraphState>>;
}

const ACTIVE = new Set(["planned", "accepted", "running", "reconciling"]);

function prNumber(s: GraphState): number | undefined {
  if (typeof s.pr === "number") return s.pr;
  if (s.pr && typeof s.pr === "object" && typeof s.pr.number === "number") return s.pr.number;
  if (typeof s.pr_binding?.number === "number") return s.pr_binding.number;
  return undefined;
}

function prUrl(s: GraphState): string | undefined {
  if (s.pr && typeof s.pr === "object" && typeof s.pr.url === "string") return s.pr.url;
  const repo = s.pr_binding?.repo ?? s.repo;
  const n = prNumber(s);
  if (repo && n) return `https://github.com/${repo}/pull/${n}`;
  return undefined;
}

function astraInfo(s: GraphState): RunView["astra"] {
  if (typeof s.astra_calls === "number") {
    return { calls: s.astra_calls, left: s.budget?.astra_left == null ? "—" : String(s.budget.astra_left), last: "—" };
  }
  const rows = Array.isArray(s.astra_calls) ? s.astra_calls : [];
  const last = rows.length ? String(rows[rows.length - 1]?.conclusion ?? "—") : "—";
  return { calls: rows.length, left: s.budget?.astra_left == null ? "—" : String(s.budget.astra_left), last };
}

export function formatElapsed(from: string | undefined, now: number): string {
  if (!from) return "—";
  const t = Date.parse(from);
  if (!Number.isFinite(t)) return "—";
  const sec = Math.max(0, Math.floor((now - t) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h${min % 60}m`;
}

function humanGates(s: GraphState): string[] {
  const out: string[] = [];
  if (s.status === "waiting_human") out.push("run 等待人工");
  if (s.next?.kind === "decide") out.push("方向门待主控裁决");
  for (const [id, n] of Object.entries(s.nodes ?? {})) {
    if (n.status === "waiting_human") out.push(`节点 ${id}`);
  }
  return out;
}

export function toRunView(state: GraphState, now = 0): RunView {
  const nodes: NodeView[] = Object.entries(state.nodes ?? {}).map(([id, n]) => {
    const dispatch = n.dispatch_state ?? n.status ?? "unknown";
    const route = n.actual_route ?? n.planned_params;
    return {
      id,
      status: n.status ?? "unknown",
      dispatch_state: dispatch,
      current: ACTIVE.has(dispatch) || n.status === "running",
      ...(n.worker_label ? { worker_label: n.worker_label } : {}),
      ...(route?.model ? { model: route.model } : {}),
      ...(route?.effort ? { effort: route.effort } : {}),
    };
  });
  const current = nodes.filter((n) => n.current).map((n) => n.id);
  const workers: WorkerView[] = nodes
    .filter((n) => n.worker_label && n.current)
    .map((n) => ({ label: n.worker_label!, model: n.model ?? "—", effort: n.effort ?? "—", dispatch_state: n.dispatch_state }));
  const jev: JevView[] = (state.jev ?? []).map((j) => ({
    gate: String(j.gate ?? "—"),
    choice: String(j.choice ?? "—"),
    confidence: j.confidence == null ? "—" : Number(j.confidence).toFixed(2),
    routed: String(j.routed ?? "—"),
    at: String(j.at ?? ""),
  }));
  const n = prNumber(state);
  const url = prUrl(state);
  const mergeable = state.verdict?.head_matches === true ? "可合并条件未齐（见 GitHub）" : "未报可合并";
  return {
    run_id: state.run_id ?? "—",
    status: state.status ?? "unknown",
    goal: state.goal ?? "（无 GOAL）",
    current_nodes: current,
    nodes,
    workers,
    jev,
    sol_decisions: (state.sol_decisions ?? []).map((d) => ({ gate: String(d.gate ?? "—"), answer: String(d.answer ?? "—"), at: String(d.at ?? "") })),
    astra: astraInfo(state),
    elapsed: formatElapsed(state.updated_at, now),
    human_gates: humanGates(state),
    github: {
      label: n && (state.pr_binding?.repo ?? state.repo) ? `${state.pr_binding?.repo ?? state.repo}#${n}` : "无 PR",
      ...(url ? { url } : {}),
      ci: state.next?.kind === "wait" ? "等待 CI" : "—",
      mergeable: state.status === "done" ? "可合并或已交接" : mergeable,
    },
  };
}

export function viewFromStates(states: readonly GraphState[], now = 0): GraphViewModel {
  const runs = states.filter((s) => s && s.run_id).map((s) => toRunView(s, now));
  return { runs, empty: runs.length === 0, empty_message: EMPTY_GRAPH_MESSAGE };
}

export function emptyStore(): GraphStore {
  return { runs: {} };
}

export function applyGraphMessage(store: GraphStore, msg: { type?: string; runs?: unknown; run?: unknown }): GraphStore {
  if (msg.type === "graph" && Array.isArray(msg.runs)) {
    const runs: Record<string, GraphState> = {};
    for (const raw of msg.runs) {
      if (raw && typeof raw === "object" && typeof (raw as GraphState).run_id === "string") {
        const s = raw as GraphState;
        runs[s.run_id!] = s;
      }
    }
    return { runs };
  }
  if ((msg.type === "graph-delta" || msg.type === "graph") && msg.run && typeof msg.run === "object" && typeof (msg.run as GraphState).run_id === "string") {
    const s = msg.run as GraphState;
    return { runs: { ...store.runs, [s.run_id!]: s } };
  }
  return store;
}

export function viewFromStore(store: GraphStore, now = 0): GraphViewModel {
  return viewFromStates(Object.values(store.runs), now);
}
