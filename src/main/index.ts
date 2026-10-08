// main.js entry: wires the `cindy` sandbox global into Host and dispatches tool calls.

import { invalidateRuntimeConfig } from "./config.ts";
import { BUILT_PROFILE, makeContext } from "./context.ts";
import { DEFAULT_THRESHOLDS } from "../shared/types.ts";
import { runTool } from "./dispatch.ts";
import { loadGraphStates } from "./graph-snapshot.ts";
import { asNudgeRun, flushNudgeCardOnToolCall, handleCardActionMessage, handleMainViewOpen, handleTurnEndMessage, isNodeClockNotification, markPendingCard, scanDrivenRuns, type HostNudgeRun } from "./host-bridge.ts";
import { NudgeController } from "./graph/nudge.ts";
import type { AgentModel, Host } from "./host.ts";

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
  async kvGet() {
    const r = await fetch("/kv");
    const data: unknown = await r.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    return data as Record<string, unknown>;
  },
  async agentModels() {
    const r = await fetch("/agent-models");
    if (!r.ok) return { ok: false, status: r.status, models: [] };
    const data: unknown = await r.json();
    const models = data && typeof data === "object" && Array.isArray((data as { models?: unknown }).models)
      ? (data as { models: AgentModel[] }).models
      : [];
    return { ok: true, status: r.status, models };
  },
  ...(cindy.tasks && typeof cindy.tasks.create === "function"
    ? {
        tasks: {
          create: (args: Record<string, unknown>) => cindy.tasks.create(args),
          send: (args: Record<string, unknown>) => cindy.tasks.send(args),
          getRun: (args: Record<string, unknown>) => cindy.tasks.getRun(args),
          readMessages: (args: Record<string, unknown>) => cindy.tasks.readMessages(args),
          list: (args: Record<string, unknown>) => cindy.tasks.list(args),
        },
      }
    : {}),
};

const nudge = new NudgeController(
  {
    async associateSession(req) {
      if (!cindy.agent?.run) return { ok: false, errorCode: "NO_AGENT", message: "宿主没有 cindy.agent.run" };
      return cindy.agent.run(req);
    },
    async continueSession(req) {
      if (!cindy.agent?.run) return { ok: false, errorCode: "NO_AGENT", message: "宿主没有 cindy.agent.run" };
      return cindy.agent.run(req);
    },
    presentCard(card) {
      // Clock / turn-end have no tool-call slot; record pending and wait for keel_run/status/wait.
      void markPendingCard(host, card.run_id);
    },
    notifyUser(message) {
      cindy.send({ type: "notify", message });
    },
  },
  { now: () => Date.now(), cardOnly: typeof cindy.agent?.run !== "function" },
);

cindy.onHostMessage(async (msg: any) => {
  if (msg.type === "tool-call") {
    const args = msg.args ?? {};
    const sessionCtx = args.session_context;
    const sessionId = typeof sessionCtx?.session_id === "string" && sessionCtx.session_id
      ? sessionCtx.session_id as string
      : undefined;
    const out = await runTool(makeContext(host, msg.callId, BUILT_PROFILE, DEFAULT_THRESHOLDS, sessionId), msg.tool, args);
    if (out.ok) {
      await flushNudgeCardOnToolCall({
        host,
        send: (m) => cindy.send(m),
        tool: String(msg.tool ?? ""),
        callId: String(msg.callId ?? ""),
        args: msg.args ?? {},
        result: out.result,
      });
      cindy.send({ type: "tool-result", callId: msg.callId, ok: true, result: out.result });
    } else cindy.send({ type: "tool-result", callId: msg.callId, ok: false, errorCode: out.errorCode, message: out.message });
    return;
  }
  const card = await handleCardActionMessage(nudge, host, msg, (m) => cindy.send(m));
  if (card.handled) {
    cindy.send({ type: "card-action-result", ...card.result as object });
    return;
  }
  const mapped = (await loadGraphStates(host)).map(asNudgeRun).filter((r): r is HostNudgeRun => r != null);
  const turn = await handleTurnEndMessage(nudge, host, mapped, msg);
  if (turn.handled) return;
  if (isNodeClockNotification(msg) || msg.type === "nudge-clock") {
    await scanDrivenRuns(nudge, host);
  }
});

channel?.addEventListener("message", (ev: MessageEvent) => {
  if ((ev.data as { type?: string } | null)?.type === "manual-changed") invalidateRuntimeConfig();
});

// Panel requests: { reqId, op: "board" | "ledger" }. Deduplicate by reqId; the panel resends until acked.
const seen = new Set<string>();
channel?.addEventListener("message", async (ev: MessageEvent) => {
  const m = ev.data as { reqId?: string; op?: string; lead_agent?: string; type?: string };
  if (m?.type === "manual-changed") return;
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
  } else if (m.op === "roles") {
    const agent = (m as { lead_agent?: string }).lead_agent ?? "claude-code";
    const r = await runTool(ctx, "roles", { lead_agent: agent });
    channel.postMessage({ type: "roles", reqId: m.reqId, lead_agent: agent, ...(r.ok ? { result: r.result } : { message: r.message }) });
  } else if (m.op === "restore") {
    // Reopened panel: last board snapshot plus the most recent fanouts from the data dir.
    const board = await host.fs({ op: "read", root: "data", path: "board/latest.json" });
    if (board.ok && board.content) channel.postMessage({ type: "board", ...JSON.parse(board.content) });
    const list = await host.fs({ op: "list", root: "data", path: "fanout" });
    const names = (list.ok ? list.entries ?? [] : []).map((e: { name: string }) => e.name).filter((n: string) => n.endsWith(".json")).sort().slice(-5);
    const fanouts = [];
    for (const n of names) {
      const r = await host.fs({ op: "read", root: "data", path: `fanout/${n}` });
      if (r.ok && r.content) {
        const f = JSON.parse(r.content);
        fanouts.push({ fanout_id: f.fanout_id, kind: f.kind, created_at: f.created_at, ingested_at: f.ingested_at ?? null, status: f.status ?? null, reported: f.reported ?? [], task: String(f.task ?? "").slice(0, 120), lanes: (f.lanes ?? []).map((l: any) => ({ label: l.label, role: l.role, route: l.route, working_dir: l.working_dir })) });
      }
    }
    channel.postMessage({ type: "fanouts", reqId: m.reqId, fanouts: fanouts.reverse() });
    const runs = await handleMainViewOpen(nudge, host);
    channel.postMessage({ type: "graph", reqId: m.reqId, runs });
  } else if (m.op === "graph") {
    const runs = await loadGraphStates(host);
    channel.postMessage({ type: "graph", reqId: m.reqId, runs });
  } else if (m.op === "schedule") {
    const r = await host.requestSchedule?.({ name: "Keel PR 巡检", prompt: "调用 Keel 插件的 pr_board 工具刷新我的 PR 看板，把可合并与阻塞的 PR 用一句话总结给我。不要合并任何 PR。", intervalMs: 60 * 60 * 1000 });
    channel.postMessage(r?.ok ? { type: "scheduled", reqId: m.reqId } : { type: "error", reqId: m.reqId, message: r?.message ?? "无法打开自动化创建面板" });
  }
});
