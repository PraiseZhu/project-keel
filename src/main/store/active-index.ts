// Active-run index for the Stop hook. Keyed by workdir (Codex session ids are not Cindy's).

import { KeelError, type Host } from "../host.ts";

export const ACTIVE_INDEX_PATH = "runs/active.json";

export interface ActiveRunEntry {
  readonly workdir: string;
  readonly run_id: string;
  readonly status: string;
  readonly current_node: string;
  readonly updated_at: string;
}

export interface ActiveIndexRow {
  readonly run_id: string;
  readonly status: string;
  readonly current_node: string;
  readonly updated_at: string;
}

export type ActiveIndex = Record<string, ActiveIndexRow>;

/** Last updated_at wins when two runs share a workdir (one slot per directory, by design). */
export function toActiveIndex(entries: readonly ActiveRunEntry[]): ActiveIndex {
  const out: ActiveIndex = {};
  for (const e of entries) {
    if (!e?.workdir) continue;
    const row: ActiveIndexRow = { run_id: e.run_id, status: e.status, current_node: e.current_node, updated_at: e.updated_at };
    const prev = out[e.workdir];
    if (!prev || prev.updated_at <= e.updated_at) out[e.workdir] = row;
  }
  return out;
}

const chain: { p: Promise<unknown> } = { p: Promise.resolve() };

export function writeActiveIndex(host: Host, index: ActiveIndex): Promise<void> {
  const work = async () => {
    const w = await host.fs({ op: "write", root: "data", path: ACTIVE_INDEX_PATH, content: `${JSON.stringify(index)}\n` });
    if (!w.ok) throw new KeelError("LEDGER_WRITE_FAILED", `活动 run 索引写入失败：${w.message ?? "未知原因"}`);
  };
  const next = chain.p.then(work, work);
  chain.p = next.then(() => undefined, () => undefined);
  return next;
}
