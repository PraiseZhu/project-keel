// main.js entry: wires the `cindy` sandbox global into Host and dispatches tool calls.

import { invalidateRuntimeConfig } from "./config.ts";
import { BUILT_PROFILE, makeContext } from "./context.ts";
import { DEFAULT_THRESHOLDS } from "../shared/types.ts";
import { runTool } from "./dispatch.ts";
import { loadGraphStates } from "./graph-snapshot.ts";
import { asNudgeRun, flushNudgeCardOnToolCall, handleCardActionMessage, handleTurnEndMessage, markPendingCard, scanDrivenRuns, type HostNudgeRun } from "./host-bridge.ts";
import { ClockWatchdog, type ClockStatus } from "./graph/clock-watchdog.ts";
import { NudgeController } from "./graph/nudge.ts";
import { CLOCK_PING_METHOD, CLOCK_STATUS_PATH } from "../shared/clock.ts";
import type { AgentModel, Host } from "./host.ts";
import { parseKvResponse } from "../shared/kv-response.ts";
import { toChildEntries } from "./host-fs.ts";
import { knownDashboardPull, refreshDashboard, restoreDashboard, updateDashboardLocal } from "./dashboard/service.ts";
import { status } from "./tools/pr.ts";

declare const cindy: any;

const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("keel") : null;

const host: Host = {
  fetch: (req) => cindy.fetch(req),
  node: (method, params, opts) =>
    cindy.node.request({ method, params, ...(opts?.callId ? { callId: opts.callId, cancelWithCall: true } : {}), timeoutMs: Math.min(120_000, Math.max(1000, opts?.timeoutMs ?? 120_000)) }),
  fs: async (req) => {
    const r = await cindy.fs(req);
    return req.op === "list" ? toChildEntries(req.path, r) : r;
  },
  confirm: (req) => cindy.confirm(req),
  progress: (callId) => void cindy.send({ type: "tool-progress", callId }),
  badge: (unread, summary) => void cindy.send({ type: "badge", unread, ...(unread && summary ? { summary } : {}) }),
  broadcast: (m) => channel?.postMessage(m),
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  async kvGet() {
    const r = await fetch("/kv");
    if (!r.ok) return parseKvResponse(r.status, false, null);
    return parseKvResponse(r.status, true, await r.json());
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

const clockWatchdog = new ClockWatchdog({
  now: () => host.now(),
  scan: () => scanDrivenRuns(nudge, host),
  ping: () => host.node(CLOCK_PING_METHOD, {}),
  log: (line) => console.warn(line),
  persist: async (status) => {
    await host.fs({ op: "write", root: "data", path: CLOCK_STATUS_PATH, content: JSON.stringify(status) });
  },
  load: async () => {
    const file = await host.fs({ op: "read", root: "data", path: CLOCK_STATUS_PATH });
    if (!file.ok || !file.content) return null;
    try {
      const parsed = JSON.parse(file.content) as { state?: string; at?: number; failCount?: number; nextAllowedPingAt?: number; error?: string };
      if (!parsed || typeof parsed.at !== "number") return null;
      return parsed as ClockStatus;
    } catch {
      return null;
    }
  },
});
clockWatchdog.start();

// Install or refresh the Claude Code / Codex Stop hooks on every start; after uninstall the hook removes itself.
void host.node("hooks/ensure", {}).then((r) => {
  if (!r.ok) console.warn(`[keel] hooks/ensure failed: ${r.message ?? "unknown"}`);
});

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
  const clock = await clockWatchdog.handle(msg);
  if (clock.handled) return;
  if (msg.type === "nudge-clock") await scanDrivenRuns(nudge, host);
});

channel?.addEventListener("message", (ev: MessageEvent) => {
  if ((ev.data as { type?: string } | null)?.type === "manual-changed") invalidateRuntimeConfig();
});

const seen = new Map<string, number>();
channel?.addEventListener("message", async (event: MessageEvent) => {
  const message = event.data;
  if (!message || typeof message !== "object" || typeof message.reqId !== "string" || message.reqId.length > 120 || typeof message.op !== "string") return;
  if (seen.has(message.reqId)) return;
  seen.set(message.reqId, Date.now());
  while (seen.size > 256) seen.delete(seen.keys().next().value!);
  const target = typeof message.panelId === "string" && message.panelId.length <= 80 ? message.panelId : undefined;
  channel.postMessage({ type: "ack", reqId: message.reqId, ...(target ? { target } : {}) });
  const ctx = makeContext(host, "");
  const scope = message.scope === "all" ? "all" : "open";
  try {
    if (message.op === "dashboard-restore" && target) {
      await restoreDashboard(ctx, scope, target);
      channel.postMessage({ type: "dashboard-done", reqId: message.reqId, target });
    } else if (message.op === "dashboard") {
      const snapshot = await refreshDashboard(ctx, { scope, force: message.force === true });
      channel.postMessage({ type: "dashboard-response", reqId: message.reqId, target, scope, complete: snapshot.complete, retryAt: snapshot.retryAt, error: snapshot.error });
    } else if (message.op === "dashboard-local" && typeof message.key === "string") {
      await updateDashboardLocal(ctx, scope, message.key);
      channel.postMessage({ type: "dashboard-done", reqId: message.reqId, target });
    } else if (message.op === "dashboard-detail" && typeof message.key === "string") {
      const ref = knownDashboardPull(host, message.key);
      if (!ref) throw new Error("这张 PR 不在已读取的看板里，请先刷新。");
      const detail = await status(ctx, { repo: ref.repo, pr: ref.number }, { jev: false });
      channel.postMessage({ type: "dashboard-detail", reqId: message.reqId, target, key: message.key, detail });
    } else if (message.op === "hooks-status") {
      const result = await host.node("hooks/status", {});
      channel.postMessage({ type: "hooks-status", reqId: message.reqId, ...(result.ok ? { result: result.result } : { message: result.message }) });
    } else if (message.op === "clock-status") {
      const file = await host.fs({ op: "read", root: "data", path: CLOCK_STATUS_PATH });
      channel.postMessage({ type: "clock-status", reqId: message.reqId, result: file.ok && file.content ? JSON.parse(file.content) : { state: "unknown" } });
    } else {
      channel.postMessage({ type: "dashboard-error", reqId: message.reqId, target, message: "此面板协议已更新，请重新打开 Keel 看板。" });
    }
  } catch (error) {
    channel.postMessage({ type: "dashboard-error", reqId: message.reqId, target, message: error instanceof Error ? error.message : "读取失败，请稍后重试。" });
  }
});
