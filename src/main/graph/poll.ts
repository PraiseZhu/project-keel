// GitHub poll budget for wait-ci runs. F-G4: ~7 points per snapshot, 5000/hour cap.

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
