import { pullKey, validPullRef, type ManagedPull } from "../../shared/dashboard.ts";
import type { ToolContext } from "../context.ts";
import type { Host } from "../host.ts";
import { KeelError } from "../host.ts";
import { loadGraphStates } from "../graph-snapshot.ts";
import type { GraphRunState } from "../graph/state.ts";

const PATH = "board/managed.json";
const tails = new WeakMap<Host, Promise<void>>();
const relevant = new Set(["pr_open", "pr_status", "pr_wait", "pr_ready", "pr_threads", "pr_reply", "keel_run", "keel_report", "keel_wait", "keel_gate"]);

function runGeneration(runId?: string): number | undefined {
  const match = typeof runId === "string" ? /^run-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-[a-f0-9]{4}$/.exec(runId) : null;
  if (!match) return undefined;
  const timestamp = Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().replace(/[-:T]/g, "").slice(0, 14) === match.slice(1).join("") ? timestamp : undefined;
}

function currentRun(candidates: GraphRunState[], ref?: ManagedPull): GraphRunState | undefined {
  const associated = candidates.find((run) => run.run_id === ref?.runId);
  const associatedGeneration = runGeneration(ref?.runId);
  if (ref?.runId && associatedGeneration === undefined) return associated;
  const eligible = ref?.runId ? candidates.filter((run) => {
    const generation = runGeneration(run.run_id);
    return generation !== undefined && generation >= associatedGeneration!;
  }) : candidates;
  if (!eligible.length) return associated;
  if (eligible.length === 1) {
    const only = eligible[0]!;
    return ref?.runId && !associated && runGeneration(only.run_id) === associatedGeneration ? undefined : only;
  }
  const generations = eligible.map((run) => runGeneration(run.run_id));
  if (generations.some((generation) => generation === undefined)) return associated;
  const latest = Math.max(...generations as number[]);
  const newest = eligible.filter((run) => runGeneration(run.run_id) === latest);
  return newest.length === 1 ? newest[0] : newest.find((run) => run.run_id === ref?.runId);
}

export function runRef(run: Partial<GraphRunState>): ManagedPull | null {
  const legacy = resultRef(run.pr);
  const repo = run.pr_binding?.repo ?? run.gh_repo ?? run.repo ?? legacy?.repo;
  const number = Number(run.pr_binding?.number ?? legacy?.number ?? run.pr);
  if (!validPullRef(repo, number)) return null;
  return { repo, number, ...(run.run_id ? { runId: run.run_id } : {}), ...(run.sol_session_id ? { sessionId: run.sol_session_id } : {}), at: Number(run.updated_at) || 0 };
}

export async function managedPulls(host: Host): Promise<ManagedPull[]> {
  const file = await host.fs({ op: "read", root: "data", path: PATH });
  if (!file.ok) {
    if (!file.message || /not found|ENOENT|不存在/i.test(file.message)) return [];
    throw new KeelError("BOARD_REGISTRY_UNAVAILABLE", "无法读取 Keel 的 PR 关联索引。");
  }
  if (!file.content) return [];
  const parsed = JSON.parse(file.content) as { version?: number; rows?: ManagedPull[] };
  if (parsed.version !== 1 || !Array.isArray(parsed.rows)) throw new KeelError("BOARD_REGISTRY_INVALID", "Keel 的 PR 关联索引格式不正确，未覆盖原数据。");
  return parsed.rows.filter((row) => row && validPullRef(row.repo, row.number));
}

async function register(host: Host, ref: ManagedPull, newRun: boolean): Promise<void> {
  const previous = tails.get(host) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const rows = new Map((await managedPulls(host)).map((row) => [pullKey(row.repo, row.number), row]));
    const key = pullKey(ref.repo, ref.number);
    const existing = rows.get(key);
    if (existing?.runId && ref.runId !== existing.runId) {
      const incoming = runGeneration(ref.runId), current = runGeneration(existing.runId);
      const newer = incoming !== undefined && current !== undefined && incoming > current;
      if (!ref.runId || (!newer && !(newRun && (incoming === undefined || current === undefined || incoming === current)))) return;
    }
    rows.set(key, { ...(existing?.runId === ref.runId ? existing : {}), ...ref });
    const written = await host.fs({ op: "write", root: "data", path: PATH, content: JSON.stringify({ version: 1, rows: [...rows.values()] }) });
    if (!written.ok) throw new KeelError("BOARD_REGISTRY_WRITE_FAILED", "PR 操作已完成，但看板关联索引保存失败。");
  });
  tails.set(host, next);
  return next;
}

function resultRef(value: unknown): { repo: string; number: number } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.pr && typeof record.pr === "object") {
    const nested = resultRef(record.pr);
    if (nested) return nested;
  }
  const number = Number(record.number ?? record.pr);
  if (validPullRef(record.repo, number)) return { repo: record.repo, number };
  if (typeof record.url === "string") {
    try {
      const url = new URL(record.url);
      const match = /^\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/|$)/.exec(url.pathname);
      if (url.origin === "https://github.com" && match && validPullRef(match[1], Number(match[2]))) return { repo: match[1]!, number: Number(match[2]) };
    } catch { return null; }
  }
  return null;
}

export async function trackDashboardResult(ctx: ToolContext, tool: string, args: Record<string, unknown>, result: unknown): Promise<void> {
  if (!relevant.has(tool) || args.board === true) return;
  let ref = resultRef(result) ?? resultRef(args);
  const output = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const runId = typeof output.run_id === "string" ? output.run_id : typeof args.run_id === "string" ? args.run_id : undefined;
  let run: Partial<GraphRunState> | undefined;
  if (runId && /^[a-z0-9][a-z0-9-]{0,63}$/.test(runId)) {
    const file = await ctx.host.fs({ op: "read", root: "data", path: `runs/${runId}/graph-state.json` });
    if (file.ok && file.content) {
      run = JSON.parse(file.content) as Partial<GraphRunState>;
      ref ??= runRef(run);
    }
  }
  if (!ref) return;
  const sessionId = run?.sol_session_id ?? ctx.sessionId;
  await register(ctx.host, { ...ref, ...(runId ? { runId } : {}), ...(sessionId ? { sessionId } : {}), at: ctx.host.now() }, tool === "keel_run");
  ctx.host.broadcast({ type: "dashboard-invalidated", key: pullKey(ref.repo, ref.number) });
}

export async function boardEvidence(host: Host): Promise<{ refs: Map<string, ManagedPull>; runs: Map<string, GraphRunState> }> {
  const refs = new Map((await managedPulls(host)).map((row) => [pullKey(row.repo, row.number), row]));
  const runs = new Map<string, GraphRunState>();
  const candidates = new Map<string, GraphRunState[]>();
  for (const raw of await loadGraphStates(host)) {
    const run = raw as unknown as GraphRunState;
    const ref = runRef(run);
    if (!ref) continue;
    const key = pullKey(ref.repo, ref.number);
    const group = candidates.get(key) ?? [];
    group.push(run);
    candidates.set(key, group);
  }
  for (const [key, group] of candidates) {
    const run = currentRun(group, refs.get(key));
    if (run) {
      runs.set(key, run);
      const existing = refs.get(key);
      refs.set(key, { ...(existing?.runId === run.run_id ? existing : {}), ...runRef(run)! });
    } else if (!refs.has(key)) {
      const { repo, number, at } = runRef(group[0]!)!;
      refs.set(key, { repo, number, at });
    }
  }
  return { refs, runs };
}
