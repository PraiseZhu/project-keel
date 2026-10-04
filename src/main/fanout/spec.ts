// Turn the Node lane plan into worker prompts, output contracts and create_workers payloads.
// The payload is copied verbatim from routing.json routes; nothing here picks a model.
// Two stages, as in upstream arena/swarm: candidates and slices first; the cross-judge and
// verifier only after those report, with the stage-1 worktrees and branches spelled out.

import { workerLabel, type FanoutKind, type LanePlan } from "../../shared/fanout.ts";

export interface PreparedLane extends LanePlan {
  readonly working_dir: string | null;
  readonly branch: string | null;
}

export interface PromptContext {
  readonly task: string;
  readonly rubric?: string;
  /** Pinned comparison commit (resolved from base_ref at plan time). */
  readonly baseSha?: string | null;
  /** HEAD of the worktree under review, for read-only reviewers. */
  readonly sceneHead?: string | null;
  /** All lanes of this fanout, so stage-2 lanes can name what they judge or verify. */
  readonly lanes?: readonly PreparedLane[];
}

const CONTRACT: Record<LanePlan["lane"], string> = {
  candidate: "回报：`git diff --stat`、设计取舍、运行过的验证命令与输出摘要、未解决项、本分支提交的 SHA。不推送、不开 PR、不合并。",
  "cross-judge": '只读。输出 ```json {"base":"<label>","graft":[...],"reasons":[...]} ```。',
  reviewer: '只读。所有发现放进一个 ```json 数组：[{"file","line","title","trigger","impact","evidence","severity_guess"}]；没有发现也要输出 ```json [] ```。没有可信触发路径的不报 P0/P1。',
  slice: "回报：改动摘要、commit SHA、验证命令与输出；末行写 `VERDICT: PASS|ISSUES|BLOCKED`。",
  verifier: "真实运行目标路径，记录命令、输出摘要与 commit SHA；末行写 `VERDICT: PASS|ISSUES|BLOCKED`。",
};

export const isStage2 = (l: LanePlan): boolean => l.lane === "cross-judge" || l.lane === "verifier";

function scope(lane: PreparedLane, c: PromptContext): string {
  if (lane.write) return `你在独立 worktree \`${lane.working_dir}\`（分支 \`${lane.branch}\`，起点 \`${c.baseSha ?? "?"}\`）里工作，只改这个目录。`;
  if (lane.lane === "reviewer" && lane.working_dir)
    return `在 \`${lane.working_dir}\` 只读审查，不改任何文件。审查范围：该目录里 \`git diff ${c.baseSha ?? "<base>"}...${c.sceneHead ?? "HEAD"}\`。`;
  return lane.working_dir ? `在 \`${lane.working_dir}\` 只读工作，不改任何文件。` : "只读，不改任何文件。";
}

function peers(c: PromptContext, kind: LanePlan["lane"]): string {
  const rows = (c.lanes ?? []).filter((l) => l.lane === kind);
  return rows.map((l) => `- ${l.label}：worktree \`${l.working_dir}\`，分支 \`${l.branch}\`（对比 \`git diff ${c.baseSha ?? "<base>"}..${l.branch}\`）`).join("\n");
}

export function promptFor(kind: FanoutKind, lane: PreparedLane, c: PromptContext): string {
  const role =
    lane.lane === "candidate" ? `独立实现一个候选方案（${kind} 的 ${lane.label}）。不要参考其他候选。`
    : lane.lane === "cross-judge" ? `候选已全部完成。对比下列候选的 diff，选出最适合做基础的一个，并列出值得嫁接的点。${c.rubric ? `评审标准：${c.rubric}` : ""}\n${peers(c, "candidate")}`
    : lane.lane === "reviewer" ? `按评审标准独立审查。${c.rubric ? `评审标准：${c.rubric}` : ""}`
    : lane.lane === "slice" ? `负责切片：${lane.slice ?? "main"}。`
    : `切片已全部完成。在下列切片分支上真实运行目标路径，独立验证它们的结论：\n${peers(c, "slice")}`;
  const rule = lane.write
    ? "规则：只做任务要求的改动，在本分支本地提交；不推送、不开 PR、不合并、不回帖；完成后把结果回报给 lead。"
    : "规则：只读，只报告不修改；不推送、不开 PR、不合并、不回帖；完成后把结果回报给 lead。";
  return [`[Keel ${kind} 车道 ${lane.label}]`, `任务：${c.task}`, role, scope(lane, c), `输出要求：${CONTRACT[lane.lane]}`, rule].join("\n");
}

function worker(fanoutId: string, kind: FanoutKind, l: PreparedLane, c: PromptContext) {
  return {
    role: l.role,
    agent: l.route.agent,
    label: workerLabel(fanoutId, l.label),
    model: l.route.model,
    ...(l.route.effort ? { effort: l.route.effort } : {}),
    ...(l.route.provider_id ? { provider_id: l.route.provider_id } : {}),
    ...(l.working_dir ? { working_dir: l.working_dir } : {}),
    initial_task: promptFor(kind, l, c),
  };
}

/** Stage 1 goes out now; stage 2 (cross-judge / verifier) only after every stage-1 lane reports. */
export function createWorkersPayload(fanoutId: string, kind: FanoutKind, lanes: readonly PreparedLane[], c: PromptContext) {
  const ctx = { ...c, lanes };
  const stage2 = lanes.filter(isStage2);
  return {
    workers: lanes.filter((l) => !isStage2(l)).map((l) => worker(fanoutId, kind, l, ctx)),
    ...(stage2.length ? { after_stage1: { workers: stage2.map((l) => worker(fanoutId, kind, l, ctx)) } } : {}),
  };
}

export function outputContract(lane: LanePlan): string {
  return CONTRACT[lane.lane];
}
