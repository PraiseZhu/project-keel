import { ACTIVITY_FRESH_MS, CLOUD_STEPS, HANDOFF_STEPS, LOCAL_STEPS, type BoardCard, type RemotePull, type ManagedPull } from "../../shared/dashboard.ts";
import type { GraphRunState } from "../graph/state.ts";
import type { HandoffRecord } from "../handoff.ts";

const LOCAL_NODES = new Set(["explore", "research", "architect-plan", "implement", "astra-unstick", "g-retry-plan", "g-retry-implement"]);
const NODE_NAMES: Record<string, string> = {
  explore: "调查代码", research: "查证资料", "architect-plan": "制定方案", implement: "实现与本地验证", "astra-unstick": "处理实现阻塞",
  "open-pr": "整理提交并推送", "wait-ci": "等待云端检查", "fix-ci": "处理 CI", "triage-threads": "处理评审", "astra-final-review": "验证当前提交",
  "g-accept": "核对就绪条件", "report-ready": "核对就绪 / 交接", done: "本轮已结束", stopped: "本轮已停止",
};

function remoteStatus(pull: RemotePull): { status: string; detail: string; index: number | null } {
  if (pull.state === "MERGED") return { status: "已合并", detail: "GitHub 已确认合并。", index: 8 };
  if (pull.state === "CLOSED") return { status: "已关闭", detail: "GitHub 已确认关闭，未合并。", index: null };
  if (pull.mergeable === "CONFLICTING" || pull.mergeState === "DIRTY") return { status: "存在合并冲突", detail: "GitHub 报告分支冲突；看板不会自动 rebase 或修改代码。", index: 0 };
  if (pull.review === "CHANGES_REQUESTED") return { status: "评审要求修改", detail: "GitHub 的当前评审结论为要求修改。", index: 1 };
  if (pull.checks === "FAILURE" || pull.checks === "ERROR") return { status: "CI 未通过", detail: "GitHub 当前提交的检查未通过；是否需要你介入由实际工作流门决定。", index: 3 };
  if (pull.checks === "PENDING" || pull.checks === "EXPECTED") return { status: "等待 CI", detail: "等待 GitHub 当前提交的检查结果。", index: 4 };
  if (pull.review === "REVIEW_REQUIRED") return { status: "等待评审", detail: "GitHub 当前仍要求评审。", index: 2 };
  if (pull.isDraft) return { status: "草案 PR", detail: "PR 仍是草案；不把检查通过当作已经 Ready。", index: 7 };
  if (pull.checks === "SUCCESS") return { status: "检查已通过", detail: "GitHub 检查已通过；可合并与交接还要核对该仓和 Keel 的门禁。", index: 8 };
  return { status: "检查状态待确认", detail: "GitHub 尚无可确认的检查汇总，不能视为全绿。", index: null };
}

export function projectPull(pull: RemotePull, options: { now: number; ref?: ManagedPull; run?: GraphRunState; handoff?: HandoffRecord | null }): BoardCard {
  const { run, ref, now } = options;
  const record = options.handoff;
  const handoff = record && (record.status === "complete" || record.status === undefined)
    && typeof record.repo === "string" && record.repo.toLowerCase() === pull.repo.toLowerCase() && record.number === pull.number ? record : null;
  const finished = pull.state === "CLOSED" || pull.state === "MERGED";
  const local = !finished && !handoff && run && LOCAL_NODES.has(run.cursor);
  const labels = local && run.task_type in LOCAL_STEPS ? LOCAL_STEPS[run.task_type as keyof typeof LOCAL_STEPS] : CLOUD_STEPS;
  const remote = remoteStatus(pull);
  const activityAt = run ? Math.max(Number(run.nodes?.[run.cursor]?.dispatch_state_at) || 0, Number(run.updated_at) || 0) : undefined;
  const sessionId = run?.sol_session_id ?? ref?.sessionId;
  const card: BoardCard = {
    ...pull, stage: handoff ? "handoff" : local ? "local" : "cloud",
    activity: finished ? "closed" : handoff ? "handed-off" : remote.index === null ? "unknown" : "waiting",
    status: remote.status, detail: remote.detail, linked: Boolean(ref || run || handoff),
    sessionLabel: (typeof run?.goal === "string" ? run.goal.trim().slice(0, 200) : "") || pull.title || "未关联任务",
    ...(run?.run_id ? { runId: run.run_id } : ref?.runId ? { runId: ref.runId } : {}),
    ...(sessionId ? { sessionId } : {}), ...(activityAt ? { activityAt } : {}),
    step: { labels: handoff ? HANDOFF_STEPS : labels, index: handoff ? 0 : local ? null : remote.index, linear: Boolean(local) },
  };
  if (handoff) {
    card.status = finished ? remote.status : "已交接";
    card.detail = finished ? remote.detail : `后续由 mini 盯梢；内部步骤未接入。GitHub：${remote.status}。`;
    return card;
  }
  if (!run || finished) {
    if (!run) card.step.index = null;
    if (!card.linked && !finished) card.detail = `未关联本机 Keel 流程，仅显示 GitHub 事实。${remote.detail}`;
    return card;
  }
  if (run.pr_binding?.head_sha && pull.headSha && run.pr_binding.head_sha !== pull.headSha) {
    card.activity = "stale";
    card.status = "工作流记录待确认";
    card.detail = "GitHub 当前提交已变化；旧提交的步骤和活动不能当作当前进度。";
    card.step.index = null;
    return card;
  }
  const pending = run.next?.kind === "decide" ? run.next : null;
  if (run.status === "done") {
    card.activity = "done";
    card.status = "本轮已结束";
    card.detail = `Keel 本轮工作流已结束，不表示 PR 已合并或仍在自动推进。GitHub：${remote.status}。`;
  } else if (pending) {
    card.activity = "needs-human";
    card.status = "等待你的决定";
    card.detail = typeof pending.question === "string" ? pending.question.slice(0, 450) : "工作流正在等待主控决定。";
  } else if (run.status === "stopped") {
    card.activity = "paused";
    card.status = "工作流已暂停";
    card.detail = run.next?.kind === "stop" && typeof run.next.reason === "string" ? run.next.reason.slice(0, 450) : "Keel 工作流已停止；GitHub PR 状态仍独立同步。";
  } else if (run.status === "running" && run.nodes?.[run.cursor]?.dispatch_state === "running") {
    card.activity = activityAt && now >= activityAt && now - activityAt <= ACTIVITY_FRESH_MS ? "running" : "stale";
    card.status = card.activity === "stale" ? "活动待确认" : NODE_NAMES[run.cursor] ?? "任务已派发";
    card.detail = card.activity === "stale" ? "任务活动证据已过期；刷新 GitHub 不会伪造任务心跳。" : "Keel 已记录当前节点在途，等待任务的实际回报。";
  } else if (local) {
    card.status = NODE_NAMES[run.cursor] ?? "本地工作流";
    card.detail = "当前节点包含多个子步骤；尚未上报具体步骤，不猜测进度。";
  }
  const progress = run.progress;
  if (local && progress && Number.isInteger(progress.step) && progress.step > 0 && progress.step <= labels.length && progress.nodeId === run.cursor && progress.dispatchKey === run.nodes?.[run.cursor]?.dispatch_key) {
    card.step.index = progress.step - 1;
    card.activityAt = progress.at;
    if (card.activity === "stale" && progress.at <= now && now - progress.at <= ACTIVITY_FRESH_MS) {
      card.activity = "running";
      card.status = labels[progress.step - 1] ?? card.status;
      card.detail = "当前步骤来自主控明确上报，未从聊天内容推断。";
    }
  }
  if (!local) {
    const cloudIndex: Record<string, number> = { "triage-threads": 1, "fix-ci": 3, "wait-ci": 4, "astra-final-review": 5, "g-accept": 6, "report-ready": 8 };
    card.step.index = cloudIndex[run.cursor] ?? card.step.index;
  }
  if ((pull.checks === "FAILURE" || pull.checks === "ERROR" || pull.mergeable === "CONFLICTING") && !card.detail.includes(remote.status)) card.detail += ` GitHub：${remote.status}。`;
  return card;
}
