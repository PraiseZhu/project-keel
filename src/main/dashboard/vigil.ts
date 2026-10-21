import { ACTIVITY_FRESH_MS, pullKey, type BoardCard } from "../../shared/dashboard.ts";
import { isVigilProgress, type VigilProgress, type VigilSnapshot } from "../../shared/vigil.ts";
import { node, type ToolContext } from "../context.ts";

export async function loadVigilProgress(ctx: ToolContext): Promise<VigilSnapshot> {
  if (!ctx.profile.vigilHomes?.length) return { rows: [], warnings: [] };
  try {
    const snapshot = await node<VigilSnapshot>(ctx, "vigil/progress");
    if (!snapshot || !Array.isArray(snapshot.rows) || !snapshot.rows.every(isVigilProgress) || !Array.isArray(snapshot.warnings)) throw new Error("invalid snapshot");
    for (const row of snapshot.rows) {
      if (!row.runId) continue;
      const ledger = await ctx.host.fs({ op: "read", root: "data", path: `runs/${row.runId}/decisions.jsonl` });
      if (!ledger.ok || !ledger.content) continue;
      try {
        row.notes = ledger.content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { at: string; kind: string; summary: string })
          .filter((note) => ["step", "evidence", "gap"].includes(note.kind) && typeof note.summary === "string" && typeof note.at === "string")
          .slice(-5).map(({ at, summary }) => ({ at, summary: summary.slice(0, 400) }));
      } catch { snapshot.warnings.push("部分 Vigil 判断台账暂不可读；任务活动仍按原始记录展示。"); }
    }
    return snapshot;
  } catch { return { rows: [], warnings: ["Vigil 进度暂不可读，请检查运行目录配置与读取权限。"] }; }
}

const LABELS = ["接收任务", "准备与核对", "修复与审查", "本地预检", "核对并推送", "等待线上检查"] as const;

function show(card: BoardCard, activity: BoardCard["activity"], status: string, detail: string, step: number | null): BoardCard {
  return { ...card, activity, status, detail, step: { labels: LABELS, index: step, linear: false } };
}

export function projectVigil(card: BoardCard, row: VigilProgress | undefined, now: number): BoardCard {
  if (!row) { const { vigil: _old, ...withoutOldProgress } = card; return withoutOldProgress; }
  if (card.state !== "OPEN") return { ...card, vigil: row, linked: true, sessionId: row.sessionId };
  const at = Math.max(row.taskAt || 0, row.activity?.at || 0, row.result?.at || 0, row.validation?.at || 0);
  if (card.runId && card.runId !== row.runId && (card.workflowAt ?? 0) > at) return card;
  const base: BoardCard = { ...card, vigil: row, linked: true, sessionId: row.sessionId, runId: row.runId ?? `vigil-${row.dispatchId}`,
    stage: "local", workflowAt: Math.min(at, now), activityAt: at > 0 && at <= now ? at : undefined };
  if (at > now) return show(base, "stale", "Vigil 活动待确认", "任务记录时间在未来，无法据此确认当前进度；请检查运行机器的时间。", null);
  if (row.superseded || card.isDraft || (row.sourceHead !== card.headSha && row.result?.head !== card.headSha))
    return show({ ...base, stage: "cloud" }, "stale", "Vigil 任务已过期", "PR 已重新交接、转回草案或提交发生变化；保留原修复对话，旧任务进度不当作当前进度。", null);
  const activeAt = row.activity?.at ?? 0;
  const terminal = row.result && row.result.at >= activeAt ? row.result : undefined;
  if (terminal?.status === "blocked") return show(base, "needs-human", "修复受阻", terminal.reason ?? "Vigil 已记录阻塞，请查看原修复对话与结果文件。", null);
  if (terminal?.status === "complete" || terminal?.status === "waiting-ci")
    return show({ ...base, stage: "cloud" }, terminal.status === "complete" ? "done" : "waiting", terminal.status === "complete" ? "本轮修复已结束" : "等待线上检查", "Vigil 已写入本轮处理结果；完整结论与推送证据见结果文件，PR 状态继续按 GitHub 核对。", 5);
  if (row.validation && row.validation.at >= activeAt) {
    const accepted = ["pass", "approved-exception"].includes(row.validation.status);
    const status = row.validation.status === "approved-exception" ? "已有验证例外，推送待确认" : accepted ? "已有通过回执，推送待确认" : "本地预检未通过";
    return show(base, accepted ? "waiting" : "needs-human", status,
      `最近验证回执：${row.validation.status}；提交 ${row.validation.head.slice(0, 12)}，退出码 ${row.validation.exitCode ?? "未取得"}。回执只证明该提交的当次验证。`, accepted ? 4 : 3);
  }
  const fresh = activeAt > 0 && activeAt <= now && now - activeAt <= ACTIVITY_FRESH_MS;
  if (!fresh) return show(base, "stale", "Vigil 活动待确认", "最近活动已过期或尚无活动记录；看板刷新不代表修复任务仍在运行。", null);
  if (row.activity?.op === "validate") return show(base, "running", "正在运行本地预检", "Vigil 验证命令仍有新活动记录；尚无完整通过结果，不表示已经推送。", 3);
  if (row.activity?.op === "finalize") return show(base, "waiting", "核对并准备推送", "helper 正在收口；实际推送与完成状态以结果回执为准。", 4);
  const blocked = row.taskStatus === "blocked" && row.taskAt >= activeAt;
  return show(base, blocked ? "needs-human" : "waiting", blocked ? "修复受阻" : "修复任务有新活动",
    blocked ? row.reason ?? "请查看原修复对话中的阻塞记录。" : `最近记录：${row.activity?.op ?? row.taskStatus}；具体实现和审查结果见原修复对话。`, null);
}

export function retainVigilOnError(card: BoardCard, previous: BoardCard | undefined, warnings: readonly string[]): BoardCard {
  if (card.vigil || !previous?.vigil || !warnings.length || card.state !== "OPEN") return card;
  return { ...card, vigil: previous.vigil, linked: true, sessionId: previous.sessionId, runId: previous.runId,
    workflowAt: previous.workflowAt, activity: "stale", status: "Vigil 进度暂不可读",
    detail: "保留上次关联任务；当前无法读取 Vigil，不沿用旧步骤作为实时进度。", step: { ...card.step, index: null } };
}

export function vigilByPull(snapshot: VigilSnapshot): Map<string, VigilProgress> {
  const rows = new Map<string, VigilProgress>();
  const ambiguous = new Set<string>();
  for (const row of snapshot.rows) {
    const key = pullKey(row.repo, row.number);
    if (ambiguous.has(key)) continue;
    if (rows.has(key)) { rows.delete(key); ambiguous.add(key); snapshot.warnings.push("同一个 PR 存在多份 Vigil 来源，未选择其中一份冒充当前任务。"); }
    else rows.set(key, row);
  }
  return rows;
}
