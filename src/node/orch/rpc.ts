// orch CLI subcommands as JSON-RPC: `orch/run` with { store, op, args }.
// Same store semantics as the upstream CLI (plain files + pid lock), no commander.

import { isAbsolute } from "node:path";
import { ToolError } from "../env.ts";
import { openStore, type Store } from "./store.ts";

const OPS: Record<string, (s: Store, a: any) => Promise<unknown>> = {
  init: (s) => s.init(),
  "units.add": (s, a) => s.units.add(a),
  "units.set": (s, a) => s.units.set(a),
  "units.get": (s, a) => s.units.get(a.id),
  "units.list": (s, a) => s.units.list(a),
  "units.counts": (s) => s.units.counts(),
  "ledger.record": (s, a) => s.ledger.record(a),
  "ledger.check": (s, a) => s.ledger.check(a),
  "ledger.summary": (s) => s.ledger.summary(),
  "inbox.push": (s, a) => s.inbox.push(a),
  "inbox.drain": (s) => s.inbox.drain(),
  "inbox.peek": (s) => s.inbox.peek(),
  "inbox.count": (s) => s.inbox.count(),
  "gates.park": (s, a) => s.gates.park(a),
  "gates.list": (s) => s.gates.list(),
  "gates.resolve": (s, a) => s.gates.resolve(a),
  "frontier.set": (s, a) => s.frontier.set(a),
  "frontier.show": (s) => s.frontier.show(),
  "standing.show": (s) => s.standing.show(),
  "standing.add": (s, a) => s.standing.add(a),
  "status.render": (s) => s.status.render(),
};

export const ORCH_OPS = Object.keys(OPS);

export async function runOrch(p: { store?: string; op?: string; args?: unknown; force?: boolean }) {
  if (!p.store || !isAbsolute(p.store)) throw new ToolError("INVALID_INPUT", "orch 需要 store（绝对路径的 store 目录）。");
  const fn = p.op ? OPS[p.op] : undefined;
  if (!fn) throw new ToolError("INVALID_INPUT", `未知 orch 操作 ${p.op}；可用：${ORCH_OPS.join("、")}。`);
  const store = openStore(p.store, { force: Boolean(p.force) });
  try {
    return await fn(store, p.args ?? {});
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError(e && (e as Error).constructor?.name === "NotFoundError" ? "NOT_FOUND" : "ORCH_ERROR", e instanceof Error ? e.message : String(e));
  } finally {
    await store.close();
  }
}
