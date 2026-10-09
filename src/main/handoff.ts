// Post-Ready handoff records. Once a PR in an automation-owned lane is marked Ready, the
// author session must stop pushing, replying or fixing; tools check this record first.

import { KeelError, type Host } from "./host.ts";
import { node, type ToolContext } from "./context.ts";
import { resolveLane } from "../shared/lanes.ts";
import type { PrSummary, VigilHandoffState, VigilReceipt } from "../shared/types.ts";

export type HandoffStatus = "pending" | "complete";

export interface HandoffRecord {
  readonly repo: string;
  readonly number: number;
  readonly at: string;
  readonly head_sha: string | null;
  readonly gate: unknown;
  readonly evidence: unknown;
  readonly watcher_receipt?: VigilReceipt;
  /** Missing on records written before pending-first handoff; treated as complete. */
  readonly status?: HandoffStatus;
  readonly was_draft?: boolean;
}

type ReconcileSnap = { pr: { isDraft: boolean; headSha: string | null }; decision: { kind: string }; gate: { applies: boolean; ok: boolean } };

const key = (repo: string, n: number) => `handoff/${repo.replace("/", "__").toLowerCase()}__${n}.json`;

export async function readHandoff(host: Host, repo: string, n: number): Promise<HandoffRecord | null> {
  const r = await host.fs({ op: "read", root: "data", path: key(repo, n) });
  return r.ok && r.content ? (JSON.parse(r.content) as HandoffRecord) : null;
}

export function isCompleteHandoff(rec: HandoffRecord | null): rec is HandoffRecord {
  return Boolean(rec) && rec!.status !== "pending";
}

export async function writeHandoff(host: Host, rec: HandoffRecord): Promise<void> {
  const w = await host.fs({ op: "write", root: "data", path: key(rec.repo, rec.number), content: JSON.stringify(rec, null, 2) });
  if (!w.ok) throw new KeelError("LEDGER_WRITE_FAILED", `交接记录写入失败：${w.message ?? "未知原因"}`);
}

/** Vigil lanes ask the helper; other lanes read the local record (finishing a pending one when `snap` shows Ready landed). */
export async function currentHandoff(ctx: ToolContext, repo: string, n: number, expected?: Pick<PrSummary, "headSha" | "state" | "isDraft">, snap?: ReconcileSnap): Promise<HandoffRecord | null> {
  const { match } = resolveLane(ctx.profile, repo);
  if (match?.handoffHelperPath === undefined) {
    const rec = await readHandoff(ctx.host, repo, n);
    const settled = snap ? await reconcileHandoff(ctx.host, rec, snap) : rec;
    return isCompleteHandoff(settled) ? settled : null;
  }
  const state = await node<VigilHandoffState | null>(ctx, "pr/handoff-state", { repo, pr: n });
  if (!state) throw new KeelError("HANDOFF_HELPER_INVALID", "配置了 Vigil 的车道未取得当前归属状态。");
  if (expected && (state.pr.headRefOid !== expected.headSha || state.pr.state !== expected.state || state.pr.isDraft !== expected.isDraft))
    throw new KeelError("HEAD_MOVED", "检查交接记录时 PR 已变化，请重新读取当前状态。");
  if (state.status !== "handed-off" || !state.receipt) return null;
  return { repo, number: n, at: new Date(ctx.host.now()).toISOString(), head_sha: state.receipt.head,
    gate: null, evidence: { source: "vigil-inspect" }, watcher_receipt: state.receipt };
}

export async function assertNotHandedOff(ctx: ToolContext, repo: string, n: number, expected?: Pick<PrSummary, "headSha" | "state" | "isDraft">): Promise<void> {
  const rec = await currentHandoff(ctx, repo, n, expected);
  if (rec)
    throw new KeelError("LANE_HANDED_OFF", `${repo}#${n} 已于 ${rec.at} 转 Ready 并交接给自动化盯梢。作者会话不再推送、回帖或修复；如需大改，请先按仓库规则把 PR 转回 Draft。`, { handoff: rec });
}

/** If Ready succeeded but the complete write did not, the next status read finishes the record. */
export async function reconcileHandoff(host: Host, rec: HandoffRecord | null, snap: ReconcileSnap): Promise<HandoffRecord | null> {
  if (!rec || rec.status !== "pending") return rec;
  if (rec.head_sha && snap.pr.headSha && rec.head_sha !== snap.pr.headSha) return rec;
  const actuallyReady = rec.was_draft ? !snap.pr.isDraft : snap.decision.kind === "ready" && (!snap.gate.applies || snap.gate.ok);
  if (!actuallyReady) return rec;
  const done: HandoffRecord = { ...rec, status: "complete", at: new Date(host.now()).toISOString() };
  await writeHandoff(host, done);
  return done;
}
