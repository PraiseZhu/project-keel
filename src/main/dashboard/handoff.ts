import type { RemotePull } from "../../shared/dashboard.ts";
import { resolveLane } from "../../shared/lanes.ts";
import type { PrStatus } from "../../shared/types.ts";
import { parseLanes } from "../config.ts";
import { node, type ToolContext } from "../context.ts";
import { currentHandoff, readHandoff, type HandoffRecord } from "../handoff.ts";
import { KeelError, type Host } from "../host.ts";
import { listLocalPushes } from "../pushes.ts";

const preparedContexts = new WeakSet<ToolContext>();

export async function prepareDashboardHandoffContext(ctx: ToolContext): Promise<ToolContext> {
  let kv: Record<string, unknown>;
  try {
    kv = await ctx.host.kvGet();
  } catch (error) {
    throw new KeelError("KV_READ_FAILED", `读取交接车道失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const lanes = parseLanes(kv && typeof kv === "object" && !Array.isArray(kv) ? kv.lanes : undefined, ctx.profile.lanes);
  const prepared = { ...ctx, profile: { ...ctx.profile, lanes } };
  preparedContexts.add(prepared);
  return prepared;
}

export async function currentDashboardHandoff(ctx: ToolContext, pull: RemotePull): Promise<HandoffRecord | null> {
  if (pull.state === "UNKNOWN") throw new KeelError("BOARD_HANDOFF_UNAVAILABLE", "当前 PR 状态未知，无法核实交接归属。");
  const expected = { headSha: pull.headSha, state: pull.state, isDraft: pull.isDraft };
  const prepared = preparedContexts.has(ctx) ? ctx : await prepareDashboardHandoffContext(ctx);
  const { match } = resolveLane(prepared.profile, pull.repo);
  if (match?.handoffHelperPath !== undefined) return currentHandoff(prepared, pull.repo, pull.number, expected);

  const host: Host = { ...prepared.host, async fs(request) {
    const result = await prepared.host.fs(request);
    if (request.op === "read" && !result.ok && !/not found|ENOENT|不存在/i.test(result.message ?? ""))
      throw new KeelError("BOARD_HANDOFF_UNAVAILABLE", "无法读取当前 PR 的交接记录。");
    return result;
  } };
  let record: HandoffRecord | null;
  try {
    record = await readHandoff(host, pull.repo, pull.number);
  } catch (error) {
    if (error instanceof KeelError) throw error;
    throw new KeelError("BOARD_HANDOFF_INVALID", "当前 PR 的交接记录无法解析。");
  }
  if (record !== null && (!record || typeof record.repo !== "string" || record.repo.toLowerCase() !== pull.repo.toLowerCase()
    || record.number !== pull.number || ![undefined, "pending", "complete"].includes(record.status)))
    throw new KeelError("BOARD_HANDOFF_INVALID", "交接记录与当前 PR 不匹配。");
  const checked = { ...prepared, host };
  if (record?.status !== "pending" || pull.isDraft || (record.head_sha && pull.headSha && record.head_sha !== pull.headSha))
    return currentHandoff(checked, pull.repo, pull.number, expected);
  if (record.was_draft)
    return currentHandoff(checked, pull.repo, pull.number, expected, { pr: pull, decision: { kind: "unknown" }, gate: { applies: false, ok: false } });

  const snapshot = await node<Pick<PrStatus, "pr" | "decision" | "gate">>(prepared, "pr/snapshot", {
    repo: pull.repo, pr: pull.number, local_pushes: await listLocalPushes(prepared.host), now_ms: prepared.host.now(),
  });
  if (!snapshot?.pr || !snapshot.decision || !snapshot.gate)
    throw new KeelError("BOARD_HANDOFF_INVALID", "未取得核实待完成交接所需的当前 PR 状态。");
  if (snapshot.pr.repo.toLowerCase() !== pull.repo.toLowerCase() || snapshot.pr.number !== pull.number
    || snapshot.pr.headSha !== pull.headSha || snapshot.pr.state !== pull.state || snapshot.pr.isDraft !== pull.isDraft)
    throw new KeelError("HEAD_MOVED", "核实待完成交接时 PR 已变化，请重新读取当前状态。");
  return currentHandoff(checked, pull.repo, pull.number, expected, snapshot);
}
