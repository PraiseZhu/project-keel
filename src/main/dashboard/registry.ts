import { pullKey, validPullRef, type ManagedPull } from "../../shared/dashboard.ts";
import type { ToolContext } from "../context.ts";
import type { Host } from "../host.ts";
import { KeelError } from "../host.ts";
import { loadGraphStates } from "../graph-snapshot.ts";
import type { GraphRunState } from "../graph/state.ts";

const PATH = "board/managed.json";
const tails = new WeakMap<Host, Promise<void>>();
const relevant = new Set(["pr_open", "pr_status", "pr_wait", "pr_ready", "pr_threads", "pr_reply", "keel_run", "keel_report", "keel_wait", "keel_gate"]);

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

async function register(host: Host, ref: ManagedPull): Promise<void> {
  const previous = tails.get(host) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const rows = new Map((await managedPulls(host)).map((row) => [pullKey(row.repo, row.number), row]));
    const key = pullKey(ref.repo, ref.number);
    rows.set(key, { ...rows.get(key), ...ref });
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
  const sessionId = ctx.sessionId ?? run?.sol_session_id;
  await register(ctx.host, { ...ref, ...(runId ? { runId } : {}), ...(sessionId ? { sessionId } : {}), at: ctx.host.now() });
  ctx.host.broadcast({ type: "dashboard-invalidated", key: pullKey(ref.repo, ref.number) });
}

export async function boardEvidence(host: Host): Promise<{ refs: Map<string, ManagedPull>; runs: Map<string, GraphRunState> }> {
  const refs = new Map((await managedPulls(host)).map((row) => [pullKey(row.repo, row.number), row]));
  const runs = new Map<string, GraphRunState>();
  for (const raw of await loadGraphStates(host)) {
    const run = raw as unknown as GraphRunState;
    const ref = runRef(run);
    if (!ref) continue;
    const key = pullKey(ref.repo, ref.number);
    const previous = runs.get(key);
    if (!previous || Number(run.updated_at) > Number(previous.updated_at)) {
      runs.set(key, run);
      refs.set(key, { ...refs.get(key), ...ref });
    }
  }
  return { refs, runs };
}
