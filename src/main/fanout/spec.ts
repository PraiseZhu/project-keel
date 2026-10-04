// Turn the Node lane plan into worker prompts, output contracts and a create_workers payload.
// The payload is copied verbatim from routing.json routes; nothing here picks a model.

import { workerLabel, type FanoutKind, type LanePlan } from "../../shared/fanout.ts";

export interface PreparedLane extends LanePlan {
  readonly working_dir: string | null;
  readonly branch: string | null;
}

const CONTRACT: Record<LanePlan["lane"], string> = {
  candidate: "回报：`git diff --stat`、设计取舍、运行过的验证命令与输出摘要、未解决项。不推送、不开 PR、不合并。",
  "cross-judge": '只读。输出 ```json {"base":"<label>","graft":[...],"reasons":[...]} ```。',
  reviewer: '只读。所有发现放进一个 ```json 数组：[{"file","line","title","trigger","impact","evidence","severity_guess"}]。没有可信触发路径的不报 P0/P1。',
  slice: "回报：改动摘要、commit SHA、验证命令与输出；末行写 `VERDICT: PASS|ISSUES|BLOCKED`。",
  verifier: "真实运行目标路径，记录命令、输出摘要与 commit SHA；末行写 `VERDICT: PASS|ISSUES|BLOCKED`。",
};

export function promptFor(kind: FanoutKind, lane: PreparedLane, task: string, rubric?: string): string {
  const where = lane.working_dir ? (lane.write ? `你在独立 worktree \`${lane.working_dir}\`（分支 \`${lane.branch}\`）里工作，只改这个目录。` : `在 \`${lane.working_dir}\` 只读审查，不改任何文件。`) : "只读，不改任何文件。";
  const role =
    lane.lane === "candidate" ? `独立实现一个候选方案（${kind} 的 ${lane.label}）。不要参考其他候选。`
    : lane.lane === "cross-judge" ? "等候选完成后，对比各候选 worktree 的 diff，选出最适合做基础的一个，并列出值得嫁接的点。"
    : lane.lane === "reviewer" ? `按评审标准独立审查。${rubric ? `评审标准：${rubric}` : ""}`
    : lane.lane === "slice" ? `负责切片：${lane.slice ?? "main"}。`
    : "独立验证其他车道的结论。";
  return [`[Keel ${kind} 车道 ${lane.label}]`, `任务：${task}`, role, where, `输出要求：${CONTRACT[lane.lane]}`, "规则：只修确认成立的 P0/P1；不推送、不开 PR、不合并、不回帖；完成后把结果回报给 lead。"].join("\n");
}

export function createWorkersPayload(fanoutId: string, kind: FanoutKind, lanes: readonly PreparedLane[], task: string, rubric?: string) {
  return {
    workers: lanes.map((l) => ({
      role: l.role,
      agent: l.route.agent,
      label: workerLabel(fanoutId, l.label),
      model: l.route.model,
      ...(l.route.effort ? { effort: l.route.effort } : {}),
      ...(l.route.provider_id ? { provider_id: l.route.provider_id } : {}),
      ...(l.working_dir ? { working_dir: l.working_dir } : {}),
      initial_task: promptFor(kind, l, task, rubric),
    })),
  };
}

export function outputContract(lane: LanePlan): string {
  return CONTRACT[lane.lane];
}
