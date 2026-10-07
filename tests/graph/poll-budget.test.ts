import { describe, expect, it } from "vitest";
import { advance } from "../../src/main/graph/interpreter.ts";
import {
  countWaitCiRuns,
  hourlyPoints,
  HOURLY_SOFT_CAP,
  isWaitCiRun,
  MIN_INTERVAL_MS,
  POINTS_PER_SNAPSHOT,
  pollIntervalMs,
} from "../../src/main/graph/poll.ts";
import { initGraphState, type GraphRunState } from "../../src/main/graph/state.ts";
import { boot, setupOk } from "./helpers.ts";

function waitCiState(id: string, active: boolean): GraphRunState {
  const s = initGraphState({
    run_id: id,
    spec_id: "bug-fix",
    profile_id: "sol",
    lead_harness: "codex",
    task_type: "bug-fix",
    entry: "wait-ci",
    goal: "x",
  });
  s.cursor = "wait-ci";
  s.nodes["wait-ci"] = { status: active ? "active" : "succeeded", attempts: 1 };
  if (!active) s.status = "done";
  return s;
}

describe("poll budget", () => {
  it("interval is max(30s, active wait-ci runs × 20s) and only wait-ci runs count", () => {
    expect(pollIntervalMs(0)).toBe(MIN_INTERVAL_MS);
    expect(pollIntervalMs(1)).toBe(MIN_INTERVAL_MS);
    expect(pollIntervalMs(2)).toBe(40_000);
    expect(pollIntervalMs(4)).toBe(80_000);
    expect(isWaitCiRun(waitCiState("a", true))).toBe(true);
    expect(isWaitCiRun(waitCiState("b", false))).toBe(false);
    expect(countWaitCiRuns([waitCiState("a", true), waitCiState("b", false), waitCiState("c", true)])).toBe(2);
  });

  it("full load stays under 4000 GraphQL points per hour", () => {
    for (const n of [1, 4, 6, 8]) {
      const interval = pollIntervalMs(n);
      const points = hourlyPoints(n, interval);
      expect(points, `${n} runs`).toBeLessThan(HOURLY_SOFT_CAP);
    }
    expect(POINTS_PER_SNAPSHOT).toBe(7);
    expect(hourlyPoints(4, 80_000)).toBe(4 * 7 * (3_600_000 / 80_000));
  });

  it("usage at the soft cap downclocks the interval", () => {
    const normal = pollIntervalMs(4, 0);
    const slow = pollIntervalMs(4, HOURLY_SOFT_CAP);
    expect(slow).toBeGreaterThan(normal);
    expect(hourlyPoints(4, slow)).toBeLessThan(hourlyPoints(4, normal));
    expect(hourlyPoints(4, slow)).toBeLessThan(HOURLY_SOFT_CAP);
  });

  it("a live run sitting on wait-ci is counted as wait-ci", async () => {
    const { h, spec } = await boot();
    const d = await setupOk(h, spec);
    if (d.next.kind !== "dispatch") throw new Error("dispatch");
    await advance(h, "run1", {
      type: "report",
      phase: "accepted",
      dispatch_key: d.next.dispatch_key,
      worker_id: "w",
      worker_session_id: "ws",
      dispatch_outcome: { created: true, delivered: true, queued: false },
    }, { spec });
    await advance(h, "run1", { type: "report", phase: "final", dispatch_key: d.next.dispatch_key, inline_report: { status: "done" } }, { spec });
    const waiting = await advance(h, "run1", { type: "tick" }, { spec });
    expect(waiting.next.kind).toBe("wait");
    expect(isWaitCiRun(waiting.state)).toBe(true);
  });
});
