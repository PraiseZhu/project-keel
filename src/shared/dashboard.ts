import type { VigilProgress } from "./vigil.ts";

export type BoardScope = "open" | "all";
export type BoardStage = "local" | "cloud" | "handoff";
export type BoardActivity = "running" | "waiting" | "needs-human" | "ready" | "handed-off" | "paused" | "done" | "unknown" | "stale" | "closed";
export type PullState = "OPEN" | "CLOSED" | "MERGED" | "UNKNOWN";

export interface RemotePull {
  key: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  state: PullState;
  isDraft: boolean;
  updatedAt: string;
  headSha: string;
  checks: "SUCCESS" | "FAILURE" | "PENDING" | "ERROR" | "EXPECTED" | "UNKNOWN";
  review: string;
  mergeable: string;
  mergeState: string;
  ci?: { passed: number; failed: number; pending: number; total: number; complete: boolean };
}

export interface PullPage {
  owner: string;
  rows: RemotePull[];
  total: number;
  nextCursor: string | null;
  remaining?: number;
  resetAt?: string;
}

export interface ManagedPull {
  repo: string;
  number: number;
  sessionId?: string;
  runId?: string;
  at: number;
}

export interface BoardCard extends RemotePull {
  vigil?: VigilProgress;
  stage: BoardStage;
  activity: BoardActivity;
  status: string;
  detail: string;
  linked: boolean;
  runId?: string;
  sessionId?: string;
  sessionLabel: string;
  activityAt?: number;
  workflowAt?: number;
  step: { index: number | null; labels: readonly string[]; linear: boolean };
  error?: string;
}

export interface BoardSnapshot {
  version: 1;
  owner: string;
  scope: BoardScope;
  rows: BoardCard[];
  total: number;
  complete: boolean;
  connection: "live" | "partial" | "offline";
  at: number;
  lastSuccessAt?: number;
  error?: string;
  retryAt?: number;
  source: "github-viewer-and-keel";
}

export const BOARD_REFRESH_MS = 30_000;
export const ACTIVITY_FRESH_MS = 90_000;
export const CLOUD_STEPS = ["处理冲突", "处理评审", "等评审", "处理 CI", "等 CI", "验证提交", "核对进场", "转 Ready", "交接 / 待合并"] as const;
export const HANDOFF_STEPS = ["已交接", "mini 盯梢", "可合并"] as const;
export const LOCAL_STEPS = {
  feature: ["调查", "设计", "执行准备", "实现", "本地验证", "整理提交", "交叉审查", "准备 PR"],
  "bug-fix": ["调查", "定位原因", "实现修复", "本地验证", "整理提交", "准备 PR"],
  refactoring: ["调查", "设计", "执行准备", "实现", "本地验证", "整理提交", "交叉审查", "准备 PR"],
} as const;

export const BOARD_COLUMNS = [
  { id: "local", index: "A", label: "本地工作流", owner: "pro", icon: "stage-local", hint: "作者侧推进到 push；只显示已记录的真实步骤" },
  { id: "cloud", index: "↻", label: "云端检查至全绿", owner: "pro", icon: "stage-loop", hint: "检查 GitHub 事实，直到交接或待合并" },
  { id: "handoff", index: "⑂", label: "已交接", owner: "mini 盯梢", icon: "stage-ready", hint: "交接以 Keel 记录为准，不猜测 mini 内部进度" },
] as const;

export function pullKey(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${number}`;
}

export function validPullRef(repo: unknown, number: unknown): repo is string {
  return typeof repo === "string" && repo.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo)
    && typeof number === "number" && Number.isSafeInteger(number) && number > 0 && number <= 2147483647;
}

export function pullUrl(repo: string, number: number): string {
  return validPullRef(repo, number) ? `https://github.com/${repo}/pull/${number}` : "";
}

export function withNewestActivity(previous: BoardCard | undefined, next: BoardCard): BoardCard {
  const safe = { ...next, url: pullUrl(next.repo, next.number) };
  if (previous && previous.runId && previous.runId === next.runId && previous.headSha === next.headSha
    && previous.state === "OPEN" && next.state === "OPEN" && !previous.error && !next.error && previous.stage !== "handoff" && next.stage !== "handoff"
    && (previous.workflowAt ?? previous.activityAt ?? 0) > (next.workflowAt ?? next.activityAt ?? 0)) {
    return { ...safe, activity: previous.activity, activityAt: previous.activityAt, workflowAt: previous.workflowAt, stage: previous.stage, status: previous.status, detail: previous.detail, step: previous.step };
  }
  return safe;
}
