import { describe, expect, it } from "vitest";
import type { AgentRunResult, ContinueSessionReq, NudgePorts } from "../../src/main/graph/nudge.ts";
import { NudgeController } from "../../src/main/graph/nudge.ts";
import { CLOCK_WATCHDOG_MS, CLOCK_PING_METHOD } from "../../src/shared/clock.ts";
import { ClockWatchdog, isNodeCrashedStatus, isNodeClockNotification } from "../../src/main/graph/clock-watchdog.ts";

const t0 = Date.UTC(2026, 9, 8, 12, 0, 0);

function tickMsg() {
  return { type: "event" as const, name: "node-notification", method: "clock.tick", params: { at: t0, count: 1 } };
}

function crashedMsg() {
  return { type: "event" as const, name: "node-status", state: "crashed" as const, ts: t0 };
}

describe("clock watchdog", () => {
  it("after a host crashed event, pings Node and still scans within 45s", async () => {
    expect(isNodeCrashedStatus(crashedMsg())).toBe(true);
    expect(isNodeCrashedStatus({ type: "event", name: "node-status", state: "stopped" })).toBe(false);
    const now = { t: t0 };
    const scans: number[] = [];
    const pings: string[] = [];
    const logs: string[] = [];
    const wd = new ClockWatchdog({
      now: () => now.t,
      scan: async () => { scans.push(now.t); },
      ping: async () => { pings.push(CLOCK_PING_METHOD); return { ok: true }; },
      log: (line) => logs.push(line),
    });
    await wd.handle(crashedMsg());
    expect(pings).toEqual([CLOCK_PING_METHOD]);
    now.t = t0 + CLOCK_WATCHDOG_MS;
    await wd.check();
    expect(scans.length).toBeGreaterThanOrEqual(1);
    expect(scans[0]! - t0).toBeLessThanOrEqual(CLOCK_WATCHDOG_MS);
  });

  it("does not let the watchdog scan while clock.tick arrives on time", async () => {
    expect(isNodeClockNotification(tickMsg())).toBe(true);
    const now = { t: t0 };
    const scans: string[] = [];
    const wd = new ClockWatchdog({
      now: () => now.t,
      scan: async () => { scans.push("scan"); },
      ping: async () => ({ ok: true }),
    });
    await wd.handle(tickMsg());
    expect(scans).toEqual(["scan"]);
    now.t = t0 + 15_000;
    await wd.check();
    expect(scans).toEqual(["scan"]);
    await wd.handle(tickMsg());
    expect(scans).toEqual(["scan", "scan"]);
    now.t = t0 + 30_000;
    await wd.check();
    expect(scans).toEqual(["scan", "scan"]);
  });

  it("overlapping tick and watchdog still issue at most one background send", async () => {
    const continues: ContinueSessionReq[] = [];
    let release: ((r: AgentRunResult) => void) | undefined;
    const first = new Promise<AgentRunResult>((r) => { release = r; });
    const p: NudgePorts = {
      async associateSession() { return { ok: true, status: "created" }; },
      async continueSession(req) {
        continues.push(req);
        if (continues.length === 1) return first;
        return { ok: true, status: "resumed" };
      },
      presentCard() {},
      notifyUser() {},
    };
    const c = new NudgeController(p, { now: () => t0 + 10 * 60_000 });
    const run = {
      run_id: "run-wd",
      status: "running" as const,
      version: 1,
      associated: true,
      session_id: "s1",
      next: { kind: "dispatch" },
      last_keel_call_at: t0,
    };
    const now = { t: t0 + 10 * 60_000 };
    const wd = new ClockWatchdog({
      now: () => now.t,
      scan: () => c.maybeNudge(run),
      ping: async () => ({ ok: true }),
    });
    wd.markStale();
    const a = wd.check();
    const b = wd.handle(tickMsg());
    await Promise.resolve();
    expect(continues).toHaveLength(1);
    release?.({ ok: true, status: "resumed" });
    await Promise.all([a, b]);
    expect(continues).toHaveLength(1);
  });

  it("a failed ping is visible, not swallowed", async () => {
    const logs: string[] = [];
    const persisted: { state: string; error?: string }[] = [];
    const wd = new ClockWatchdog({
      now: () => t0,
      scan: async () => {},
      ping: async () => ({ ok: false, message: "HOST_NOT_READY" }),
      log: (line) => logs.push(line),
      persist: async (s) => { persisted.push(s); },
    });
    await wd.handle(crashedMsg());
    expect(persisted.some((s) => s.state === "restart_failed")).toBe(true);
    expect(logs.some((l) => /HOST_NOT_READY|拉起失败|crashed/.test(l))).toBe(true);
  });
});
