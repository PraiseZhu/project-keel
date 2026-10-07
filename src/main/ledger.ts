// Decision and step ledger in the plugin's private data dir.
// State is stored as a sha256, never verbatim, to keep size and privacy in check.

import { KeelError, type Host } from "./host.ts";

export type LedgerKind = "decision" | "step" | "evidence" | "gap";

export interface LedgerRow {
  readonly row_id: string;
  readonly at: string;
  readonly run_id: string;
  readonly kind: LedgerKind;
  readonly summary: string;
  readonly template?: string;
  readonly state_sha256?: string;
  readonly options?: readonly string[];
  readonly answer?: unknown;
  readonly confidence?: number;
  readonly policy?: string;
  readonly evidence?: unknown;
}

const RUN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export async function sha256(value: unknown): Promise<string> {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newRunId(now: number): string {
  const d = new Date(now);
  const stamp = d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `run-${stamp}-${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0")}`;
}

function path(runId: string) {
  if (!RUN_ID.test(runId)) throw new KeelError("INVALID_INPUT", "run_id 只能含小写字母、数字和连字符。");
  return `runs/${runId}/decisions.jsonl`;
}

async function readLines(host: Host, p: string): Promise<LedgerRow[] | null> {
  const r = await host.fs({ op: "read", root: "data", path: p });
  if (!r.ok) return null;
  return (r.content ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l) as LedgerRow);
}

/** One Promise chain per run covering the whole read-modify-write. Concurrent appends must not drop rows. */
const chains = new Map<string, Promise<unknown>>();

function serialized<T>(runId: string, work: () => Promise<T>): Promise<T> {
  const prev = chains.get(runId) ?? Promise.resolve();
  const next = prev.then(work, work);
  chains.set(runId, next.then(() => undefined, () => undefined));
  return next;
}

async function appendOnce(host: Host, row: Omit<LedgerRow, "row_id" | "at">): Promise<LedgerRow> {
  const p = path(row.run_id);
  const existing = (await readLines(host, p)) ?? [];
  const full: LedgerRow = { row_id: `${row.run_id}#${existing.length + 1}`, at: new Date(host.now()).toISOString(), ...row };
  const content = [...existing, full].map((r) => JSON.stringify(r)).join("\n") + "\n";
  const w = await host.fs({ op: "write", root: "data", path: p, content });
  if (!w.ok) throw new KeelError("LEDGER_WRITE_FAILED", `台账写入失败：${w.message ?? "未知原因"}`);
  return full;
}

export async function append(host: Host, row: Omit<LedgerRow, "row_id" | "at">): Promise<LedgerRow> {
  return serialized(row.run_id, () => appendOnce(host, row));
}

export async function read(host: Host, runId?: string, limit = 50): Promise<LedgerRow[]> {
  if (runId) {
    const rows = await readLines(host, path(runId));
    if (rows === null) throw new KeelError("RUN_NOT_FOUND", `找不到 run ${runId} 的台账。先用 pstack_start 开始一次运行。`);
    return rows.slice(-limit);
  }
  const list = await host.fs({ op: "list", root: "data", path: "runs" });
  const runs = (list.entries ?? []).map((e) => e.name).filter((n) => RUN_ID.test(n)).sort().slice(-5);
  const out: LedgerRow[] = [];
  for (const r of runs) out.push(...((await readLines(host, path(r))) ?? []));
  return out.slice(-limit);
}
