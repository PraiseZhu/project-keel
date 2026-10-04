// main.js entry: wires the `cindy` sandbox global into Host and dispatches tool calls.

import { makeContext } from "./context.ts";
import { runTool } from "./dispatch.ts";
import type { Host } from "./host.ts";

declare const cindy: any;

const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("keel") : null;

const host: Host = {
  fetch: (req) => cindy.fetch(req),
  node: (method, params, opts) =>
    cindy.node.request({ method, params, ...(opts?.callId ? { callId: opts.callId, cancelWithCall: true } : {}), timeoutMs: Math.min(120_000, Math.max(1000, opts?.timeoutMs ?? 120_000)) }),
  fs: (req) => cindy.fs(req),
  confirm: (req) => cindy.confirm(req),
  progress: (callId) => void cindy.send({ type: "tool-progress", callId }),
  badge: (unread, summary) => void cindy.send({ type: "badge", unread, ...(unread && summary ? { summary } : {}) }),
  broadcast: (m) => channel?.postMessage(m),
  requestSchedule: (req) => cindy.agent.requestSchedule(req),
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

cindy.onHostMessage(async (msg: any) => {
  if (msg.type !== "tool-call") return;
  const out = await runTool(makeContext(host, msg.callId), msg.tool, msg.args ?? {});
  if (out.ok) cindy.send({ type: "tool-result", callId: msg.callId, ok: true, result: out.result });
  else cindy.send({ type: "tool-result", callId: msg.callId, ok: false, errorCode: out.errorCode, message: out.message });
});

// Panel requests: { reqId, op: "board" | "ledger" }. Deduplicate by reqId; the panel resends until acked.
const seen = new Set<string>();
channel?.addEventListener("message", async (ev: MessageEvent) => {
  const m = ev.data as { reqId?: string; op?: string };
  if (!m?.reqId || seen.has(m.reqId) || m.op === undefined) return;
  seen.add(m.reqId);
  channel.postMessage({ type: "ack", reqId: m.reqId });
  const ctx = makeContext(host, "");
  if (m.op === "board") {
    const r = await runTool(ctx, "pr_board", {});
    if (!r.ok) channel.postMessage({ type: "error", reqId: m.reqId, message: r.message });
  } else if (m.op === "ledger") {
    const r = await runTool(ctx, "pstack_ledger", { op: "read", limit: 100 });
    channel.postMessage({ type: "ledger", reqId: m.reqId, ...(r.ok ? { rows: (r.result as any).rows } : { message: r.message }) });
  } else if (m.op === "schedule") {
    const r = await host.requestSchedule?.({ name: "Keel PR 巡检", prompt: "调用 Keel 插件的 pr_board 工具刷新我的 PR 看板，把可合并与阻塞的 PR 用一句话总结给我。不要合并任何 PR。", intervalMs: 60 * 60 * 1000 });
    channel.postMessage(r?.ok ? { type: "scheduled", reqId: m.reqId } : { type: "error", reqId: m.reqId, message: r?.message ?? "无法打开自动化创建面板" });
  }
});
