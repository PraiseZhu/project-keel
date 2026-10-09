// GitHub poll budget for wait-ci runs. F-G4: ~7 points per snapshot, 5000/hour cap.

import type { Host } from "../host.ts";
import type { GraphRunState } from "./state.ts";

export const POINTS_PER_SNAPSHOT = 7;
export const MIN_INTERVAL_MS = 30_000;
export const INTERVAL_PER_RUN_MS = 20_000;
export const HOURLY_SOFT_CAP = 4000;

export function isWaitCiRun(state: GraphRunState): boolean {
  if (state.status === "done" || state.status === "stopped") return false;
  const node = state.nodes["wait-ci"];
  if (!node) return state.cursor === "wait-ci";
  if (node.status === "succeeded" || node.status === "failed" || node.status === "skipped") return false;
  if (node.dispatch_state === "terminal") return false;
  return state.cursor === "wait-ci" || node.status === "active";
}

export function pollIntervalMs(activeWaitCiRuns: number, pointsUsedThisHour = 0): number {
  const n = Math.max(0, activeWaitCiRuns);
  let ms = Math.max(MIN_INTERVAL_MS, n * INTERVAL_PER_RUN_MS);
  if (n === 0) return MIN_INTERVAL_MS;
  if (pointsUsedThisHour >= HOURLY_SOFT_CAP) ms = Math.max(ms * 2, 120_000);
  return ms;
}

export function hourlyPoints(activeWaitCiRuns: number, intervalMs: number): number {
  if (activeWaitCiRuns <= 0 || intervalMs <= 0) return 0;
  return (3_600_000 / intervalMs) * POINTS_PER_SNAPSHOT * activeWaitCiRuns;
}

export function countWaitCiRuns(states: readonly GraphRunState[]): number {
  return states.filter(isWaitCiRun).length;
}

export const POLL_BUDGET_PATH = "poll-budget.json";
export const HOUR_MS = 3_600_000;
export type PollBudgetSource = "github" | "estimated";
export interface PollBudget {
  hour_start_ms: number;
  points_used: number;
  source: PollBudgetSource;
}

export function emptyPollBudget(now: number): PollBudget {
  return { hour_start_ms: now, points_used: 0, source: "estimated" };
}

export function budgetInHour(budget: PollBudget, now: number): PollBudget {
  if (now - budget.hour_start_ms >= HOUR_MS) return emptyPollBudget(now);
  return budget;
}

export function addEstimatedPoints(budget: PollBudget, now: number, points: number): PollBudget {
  const cur = budgetInHour(budget, now);
  if (cur.source === "github") return cur;
  return { hour_start_ms: cur.hour_start_ms, points_used: cur.points_used + points, source: "estimated" };
}

export function applyGithubUsed(budget: PollBudget, now: number, used: number): PollBudget {
  const cur = budgetInHour(budget, now);
  return { hour_start_ms: cur.hour_start_ms, points_used: used, source: "github" };
}

export async function loadPollBudget(host: Host, now: number): Promise<PollBudget> {
  const r = await host.fs({ op: "read", root: "data", path: POLL_BUDGET_PATH });
  if (!r.ok || !r.content) return emptyPollBudget(now);
  try {
    const parsed = JSON.parse(r.content) as Partial<PollBudget>;
    if (typeof parsed.hour_start_ms !== "number" || typeof parsed.points_used !== "number") return emptyPollBudget(now);
    const source: PollBudgetSource = parsed.source === "github" ? "github" : "estimated";
    return budgetInHour({ hour_start_ms: parsed.hour_start_ms, points_used: parsed.points_used, source }, now);
  } catch {
    return emptyPollBudget(now);
  }
}

export async function savePollBudget(host: Host, budget: PollBudget): Promise<void> {
  await host.fs({ op: "write", root: "data", path: POLL_BUDGET_PATH, content: JSON.stringify(budget) });
}
