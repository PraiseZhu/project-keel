import { LOCAL_STEPS } from "../../shared/dashboard.ts";
import { PSTACK_GRAPHS, type GraphTaskType } from "../../shared/graph/pstack.ts";
import { requireString, type ToolContext } from "../context.ts";
import type { GraphRunState } from "../graph/state.ts";
import { KeelError } from "../host.ts";
import { withExistingRun } from "../store/runs.ts";

export async function recordDashboardProgress(ctx: ToolContext, args: Record<string, unknown>) {
  const runId = requireString(args, "run_id");
  const dispatchKey = requireString(args, "dispatch_key");
  const step = args.step;
  if (!Number.isInteger(step) || Number(step) < 1) throw new KeelError("INVALID_INPUT", "step 必须是从1开始的当前真实子步骤编号。");
  const result = await withExistingRun(ctx.host, runId, (raw) => {
    const state = raw as unknown as GraphRunState;
    if (!ctx.sessionId || !state.sol_session_id || ctx.sessionId !== state.sol_session_id) throw new KeelError("NOT_LEAD", "只有该run已绑定的主控会话可上报步骤。");
    const labels = LOCAL_STEPS[state.task_type as keyof typeof LOCAL_STEPS];
    const current = state.nodes?.[state.cursor];
    const spec = PSTACK_GRAPHS[state.spec_id as GraphTaskType]?.nodes.find((node) => node.id === state.cursor);
    if (!labels || Number(step) > labels.length || !spec?.playbook_steps.includes(`${state.task_type}#${step}`)) throw new KeelError("INVALID_INPUT", "这个子步骤不属于当前任务节点，未记录。");
    if (state.status !== "running" || current?.dispatch_state !== "running" || current.dispatch_key !== dispatchKey) throw new KeelError("DISPATCH_KEY_STALE", "节点不在运行或dispatch_key已过期，未改动步骤。");
    state.progress = { nodeId: state.cursor, dispatchKey, step: Number(step), at: ctx.host.now() };
    state.updated_at = ctx.host.now();
    return { run_id: runId, recorded: true, progress: state.progress };
  });
  if (!result) throw new KeelError("RUN_NOT_FOUND", "没有找到要更新步骤的run。");
  return result;
}
