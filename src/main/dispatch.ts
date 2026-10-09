// Tool name → handler. The merge guard test asserts this table and ghost.json agree
// and that neither ever contains a merge tool.

import { loadRuntimeConfig } from "./config.ts";
import { KeelError } from "./host.ts";
import type { ToolContext } from "./context.ts";
import { fanoutTool } from "./fanout/tools.ts";
import { jevTool } from "./tools/jev.ts";
import { keelGate, keelReport, keelRun, keelStatus, keelWait } from "./tools/keel.ts";
import { worktreeTool } from "./tools/misc.ts";
import { prOpen, prReady, prReply, prStatus, prThreads, prWait } from "./tools/pr.ts";
import { pstackDecideTool, pstackStart } from "./tools/pstack.ts";

export type Handler = (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>;

export const TOOLS: Readonly<Record<string, Handler>> = {
  jev: jevTool,
  keel_run: keelRun,
  keel_report: keelReport,
  keel_wait: keelWait,
  keel_gate: keelGate,
  keel_status: keelStatus,
  pstack_start: pstackStart,
  pstack_decide: pstackDecideTool,
  pr_status: prStatus,
  pr_wait: prWait,
  pr_open: prOpen,
  pr_ready: prReady,
  pr_threads: prThreads,
  pr_reply: prReply,
  worktree: worktreeTool,
  fanout: fanoutTool,
};

export async function runTool(ctx: ToolContext, tool: string, args: Record<string, unknown>): Promise<{ ok: true; result: unknown } | { ok: false; errorCode: string; message: string; data?: unknown }> {
  const h = TOOLS[tool];
  if (!h) return { ok: false, errorCode: "UNKNOWN_TOOL", message: `Keel 没有 ${tool} 工具。` };
  try {
    const cfg = await loadRuntimeConfig(ctx.host, ctx.profile);
    const inner: ToolContext = {
      host: ctx.host,
      callId: ctx.callId,
      profile: { ...ctx.profile, lanes: cfg.lanes },
      thresholds: cfg.thresholds,
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    };
    return { ok: true, result: await h(inner, args ?? {}) };
  } catch (e) {
    if (e instanceof KeelError) return { ok: false, errorCode: e.code, message: e.message, ...(e.data ? { data: e.data } : {}) };
    return { ok: false, errorCode: "REQUEST_FAILED", message: `执行失败：${e instanceof Error ? e.message : String(e)}` };
  }
}
