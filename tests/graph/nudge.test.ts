import { describe, expect, it } from "vitest";
import { ENABLE_AUTOPILOT, PAUSE_RUN, renderNudgeCard, runIdFromCardAction } from "../../src/main/graph/cards.ts";
import {
  countUserMessageSlots,
  IDLE_MS,
  NUDGE_INTERVAL_MS,
  NUDGE_PROMPT_TEMPLATE,
  NudgeController,
  nudgePrompt,
  scanNudgeClock,
  onlyHealthyRunning,
  pendingLeadAction,
  shouldNudge,
  type AgentRunResult,
  type AssociateSessionReq,
  type ContinueSessionReq,
  type NudgePorts,
  type NudgeRun,
} from "../../src/main/graph/nudge.ts";

const t0 = Date.UTC(2026, 9, 7, 12, 0, 0);

function run(over: Partial<NudgeRun> = {}): NudgeRun {
  return {
    run_id: "run-1",
    status: "running",
    version: 1,
    next: { kind: "dispatch" },
    last_keel_call_at: t0,
    associated: true,
    session_id: "sess-1",
    nodes: [],
    ...over,
  };
}

describe("shouldNudge", () => {
  it("nudges when a lead next is pending and the lead has been idle ≥ 3 minutes", () => {
    expect(shouldNudge(run(), t0 + IDLE_MS).nudge).toBe(true);
    expect(shouldNudge(run(), t0 + IDLE_MS - 1).nudge).toBe(false);
  });
  it("does not nudge quiet statuses", () => {
    for (const status of ["paused", "stopped", "done", "waiting_human"] as const) {
      expect(shouldNudge(run({ status }), t0 + IDLE_MS * 2)).toEqual({ nudge: false, pause: false, reason: "quiet" });
    }
  });
  it("pauses on interrupted and does not nudge", () => {
    expect(shouldNudge(run(), t0, { turn: { endReason: "interrupted" } })).toEqual({ nudge: false, pause: true, reason: "interrupted" });
  });
  it("nudges on did-turn-end completed even before the idle window", () => {
    expect(shouldNudge(run(), t0 + 1000, { turn: { endReason: "completed" } })).toMatchObject({ nudge: true, reason: "turn_completed" });
  });
  it("does not nudge when every in-flight node is healthy running and next is not a lead action", () => {
    const r = run({
      next: { kind: "wait" },
      nodes: [{ dispatch_state: "running", started_at: t0, timebox_ms: IDLE_MS * 10 }],
    });
    expect(onlyHealthyRunning(r, t0 + 1000)).toBe(true);
    expect(shouldNudge(r, t0 + IDLE_MS * 2).nudge).toBe(false);
    expect(shouldNudge(r, t0 + 1000, { turn: { endReason: "completed" } })).toEqual({ nudge: false, pause: false, reason: "healthy_running" });
  });
  it("treats accepted / reconciling / timed-out running as lead work", () => {
    expect(pendingLeadAction(run({ next: { kind: "wait" }, nodes: [{ dispatch_state: "accepted" }] }), t0)).toBe(true);
    expect(pendingLeadAction(run({ next: { kind: "wait" }, nodes: [{ dispatch_state: "reconciling" }] }), t0)).toBe(true);
    const timed = run({
      next: { kind: "wait" },
      nodes: [{ dispatch_state: "running", started_at: t0, timebox_ms: 1000 }],
    });
    expect(shouldNudge(timed, t0 + IDLE_MS).nudge).toBe(true);
  });
});

function ports() {
  const log: { associate: AssociateSessionReq[]; continue: ContinueSessionReq[]; cards: string[]; notes: string[] } = {
    associate: [], continue: [], cards: [], notes: [],
  };
  let hang: ((v: AgentRunResult) => void) | null = null;
  const hangWaiters: { useHang: boolean; next: AgentRunResult | null } = { useHang: false, next: null };
  const p: NudgePorts & { log: typeof log; release: (v: AgentRunResult) => void } = {
    log,
    async associateSession(req) {
      log.associate.push(req);
      return hangWaiters.next ?? { ok: true, status: "created" };
    },
    async continueSession(req) {
      log.continue.push(req);
      if (hangWaiters.useHang) return new Promise((resolve) => { hang = resolve; });
      return hangWaiters.next ?? { ok: true, status: "resumed" };
    },
    presentCard(card) { log.cards.push(card.run_id + ":" + card.buttons.map((b) => b.label).join(",")); },
    notifyUser(message) { log.notes.push(message); },
    release(v) { hang?.(v); hang = null; },
  };
  return { p, hangWaiters };
}

describe("NudgeController queue and streak", () => {
  it("sends the fixed prompt via background continue and enforces one-in-flight plus ≥10s gap", async () => {
    const clock = { t: t0 + IDLE_MS };
    const { p, hangWaiters } = ports();
    hangWaiters.useHang = true;
    const c = new NudgeController(p, { now: () => clock.t });
    const r = run({ associated: true });
    const first = c.maybeNudge(r);
    const busy = await c.maybeNudge(r);
    expect(busy.action).toBe("skip");
    expect(busy.reason).toBe("busy");
    p.release({ ok: true });
    expect((await first).action).toBe("continue");
    expect(p.log.continue[0]).toMatchObject({
      mode: "continue",
      trigger: "background",
      sessionId: "sess-1",
      promptTemplate: NUDGE_PROMPT_TEMPLATE,
      userMessage: nudgePrompt("run-1"),
      event: { runId: "run-1" },
    });
    expect(p.log.continue[0]).not.toHaveProperty("prompt");
    expect(p.log.continue[0]).not.toHaveProperty("userActionToken");
    clock.t += NUDGE_INTERVAL_MS - 1;
    expect((await c.maybeNudge(r)).reason).toBe("interval");
    clock.t += 1;
    hangWaiters.useHang = false;
    expect((await c.maybeNudge(r)).action).toBe("continue");
  });
  it("stalls and notifies after 3 nudges with no version change", async () => {
    const clock = { t: t0 + IDLE_MS };
    const { p } = ports();
    const c = new NudgeController(p, { now: () => clock.t });
    const r = run({ associated: true });
    expect((await c.maybeNudge(r)).action).toBe("continue");
    clock.t += NUDGE_INTERVAL_MS;
    expect((await c.maybeNudge(r)).action).toBe("continue");
    clock.t += NUDGE_INTERVAL_MS;
    expect((await c.maybeNudge(r)).action).toBe("continue");
    clock.t += NUDGE_INTERVAL_MS;
    const stall = await c.maybeNudge(r);
    expect(stall.action).toBe("stall");
    expect(stall.stalled).toBe(true);
    expect(p.log.notes[0]).toMatch(/人工门/);
    expect((await c.maybeNudge(r)).reason).toBe("stalled");
  });
  it("resets the streak when the run version changes", async () => {
    const clock = { t: t0 + IDLE_MS };
    const { p } = ports();
    const c = new NudgeController(p, { now: () => clock.t });
    expect((await c.maybeNudge(run({ associated: true, version: 1 }))).action).toBe("continue");
    clock.t += NUDGE_INTERVAL_MS;
    expect((await c.maybeNudge(run({ associated: true, version: 1 }))).action).toBe("continue");
    clock.t += NUDGE_INTERVAL_MS;
    expect((await c.maybeNudge(run({ associated: true, version: 2 }))).action).toBe("continue");
    clock.t += NUDGE_INTERVAL_MS;
    expect((await c.maybeNudge(run({ associated: true, version: 2 }))).action).toBe("continue");
  });
});

describe("association and P0-2 fallback", () => {
  it("presents a card when continue reports the association is gone", async () => {
    const clock = { t: t0 + IDLE_MS };
    const { p, hangWaiters } = ports();
    hangWaiters.next = { ok: false, errorCode: "NOT_ASSOCIATED", message: "未关联" };
    const c = new NudgeController(p, { now: () => clock.t });
    const out = await c.maybeNudge(run({ associated: true }));
    expect(out.action).toBe("card");
    expect(out.reason).toBe("association_lost");
    expect(p.log.cards[0]).toContain("启用自动续跑");
    expect(c.stateOf("run-1").associated).toBe(false);
  });
  it("always presents a card when the P0-2 fallback switch is on", async () => {
    const clock = { t: t0 + IDLE_MS };
    const { p } = ports();
    const c = new NudgeController(p, { now: () => clock.t, cardOnly: true });
    const out = await c.maybeNudge(run({ associated: true }));
    expect(out.action).toBe("card");
    expect(out.reason).toBe("card_only");
    expect(p.log.continue).toHaveLength(0);
  });
  it("presents a card when the run is not associated yet", async () => {
    const clock = { t: t0 + IDLE_MS };
    const { p } = ports();
    const c = new NudgeController(p, { now: () => clock.t });
    expect((await c.maybeNudge(run({ associated: false }))).action).toBe("card");
    expect(p.log.continue).toHaveLength(0);
  });
  it("pauses on interrupted via onTurnEnd", async () => {
    const { p } = ports();
    const c = new NudgeController(p, { now: () => t0 + IDLE_MS });
    const out = await c.onTurnEnd(run(), { endReason: "interrupted" });
    expect(out).toMatchObject({ action: "pause", pause: true });
    expect(p.log.continue).toHaveLength(0);
  });
});

describe("cards and host-issued userActionToken", () => {
  it("renders the two required buttons", () => {
    const card = renderNudgeCard("run-1");
    expect(card.buttons.map((b) => b.label)).toEqual(["启用自动续跑", "暂停"]);
    expect(card.buttons.map((b) => b.id)).toEqual([ENABLE_AUTOPILOT, PAUSE_RUN]);
    expect(runIdFromCardAction({ actionId: ENABLE_AUTOPILOT, cardId: "keel-nudge-run-9" })).toBe("run-9");
  });
  it("forwards the host token as-is on enable and does not call ports without one", async () => {
    const { p } = ports();
    const c = new NudgeController(p, { now: () => t0 });
    const missing = await c.handleCardAction({ actionId: ENABLE_AUTOPILOT, run_id: "run-1", callId: "c1" });
    expect(missing).toMatchObject({ ok: false, error: "缺少 userActionToken" });
    expect(p.log.associate).toHaveLength(0);
    const token = "host-issued-uat-abc";
    const ok = await c.handleCardAction({ actionId: ENABLE_AUTOPILOT, userActionToken: token, run_id: "run-1", callId: "c2" });
    expect(ok).toMatchObject({ ok: true, action: "associate", status: "created" });
    expect(p.log.associate).toEqual([{
      mode: "continue",
      userActionToken: token,
      promptTemplate: NUDGE_PROMPT_TEMPLATE,
      userMessage: nudgePrompt("run-1"),
      event: { actionId: ENABLE_AUTOPILOT, callId: "c2" },
    }]);
    expect(c.stateOf("run-1").associated).toBe(true);
  });
  it("records the host error and does not associate when agent.run fails", async () => {
    const { p, hangWaiters } = ports();
    hangWaiters.next = { ok: false, errorCode: "TOKEN_EXPIRED", message: "userActionToken 已过期" };
    const c = new NudgeController(p, { now: () => t0 });
    const r = await c.handleCardAction({ actionId: ENABLE_AUTOPILOT, userActionToken: "stale", run_id: "run-1" });
    expect(r).toMatchObject({ ok: false, error: "TOKEN_EXPIRED" });
    expect(c.stateOf("run-1").associated).toBe(false);
    expect(c.stateOf("run-1").lastHostError).toBe("TOKEN_EXPIRED");
  });
  it("pauses without calling agent.run", async () => {
    const { p } = ports();
    const c = new NudgeController(p, { now: () => t0 });
    const r = await c.handleCardAction({ actionId: PAUSE_RUN, run_id: "run-1" });
    expect(r).toMatchObject({ ok: true, action: "pause" });
    expect(p.log.associate).toHaveLength(0);
    expect(p.log.continue).toHaveLength(0);
    expect(c.stateOf("run-1").paused).toBe(true);
    expect(c.stateOf("run-1").associated).toBe(false);
  });
  it("background nudge never reuses a card token", async () => {
    const clock = { t: t0 + IDLE_MS };
    const { p } = ports();
    const c = new NudgeController(p, { now: () => clock.t });
    await c.handleCardAction({ actionId: ENABLE_AUTOPILOT, userActionToken: "host-uat", run_id: "run-1" });
    await c.maybeNudge(run({ associated: true }));
    expect(p.log.continue).toHaveLength(1);
    expect(p.log.continue[0]).toMatchObject({ trigger: "background" });
    expect(p.log.continue[0]).not.toHaveProperty("userActionToken");
    expect(p.log.associate[0]?.userActionToken).toBe("host-uat");
  });
});

describe("§4.11 promptTemplate contract", () => {
  it("uses a template with exactly one {{user_message}} slot", () => {
    expect(countUserMessageSlots(NUDGE_PROMPT_TEMPLATE)).toBe(1);
    expect(countUserMessageSlots(nudgePrompt("run-1"))).toBe(0);
  });
  it("background continue fields match the Cindy §4.11 agent.run background call", async () => {
    const clock = { t: t0 + IDLE_MS };
    const { p } = ports();
    const c = new NudgeController(p, { now: () => clock.t });
    await c.maybeNudge(run({ associated: true }));
    const req = p.log.continue[0]!;
    expect(req.mode).toBe("continue");
    expect(req.trigger).toBe("background");
    expect(req.sessionId).toBe("sess-1");
    expect(req.promptTemplate).toBe(NUDGE_PROMPT_TEMPLATE);
    expect(countUserMessageSlots(req.promptTemplate)).toBe(1);
    expect(req.userMessage).toBe(nudgePrompt("run-1"));
    expect(req.event).toEqual({ runId: "run-1" });
    expect(req).not.toHaveProperty("prompt");
    expect(req).not.toHaveProperty("userActionToken");
  });
});

describe("plugin-level background queue", () => {
  it("keeps one in-flight across runs, rotates fairly, and does not count RATE_LIMITED as no_progress", async () => {
    const clock = { t: t0 + IDLE_MS };
    const { p, hangWaiters } = ports();
    hangWaiters.useHang = true;
    const c = new NudgeController(p, { now: () => clock.t });
    const a = run({ run_id: "run-a", associated: true, session_id: "sess-a" });
    const b = run({ run_id: "run-b", associated: true, session_id: "sess-b" });
    const first = c.maybeNudge(a);
    const busy = await c.maybeNudge(b);
    expect(busy.action).toBe("skip");
    expect(busy.reason).toBe("busy");
    expect(p.log.continue).toHaveLength(1);
    p.release({ ok: true });
    expect((await first).action).toBe("continue");

    hangWaiters.useHang = false;
    hangWaiters.next = { ok: false, errorCode: "RATE_LIMITED" };
    for (let i = 0; i < 4; i++) {
      clock.t += NUDGE_INTERVAL_MS;
      await c.maybeNudge(a);
      await c.maybeNudge(b);
      const inflight = p.log.continue.length;
      expect(inflight).toBeGreaterThan(0);
    }
    const bSends = p.log.continue.filter((req) => req.sessionId === "sess-b");
    expect(bSends.length).toBeGreaterThanOrEqual(1);
    expect(c.stateOf("run-b").stalled).toBe(false);
    expect(c.stateOf("run-b").consecutiveWithoutProgress).toBe(0);
    expect(c.stateOf("run-a").consecutiveWithoutProgress).toBe(1);
  });
});

describe("healthy running suppresses completed", () => {
  it("does not wake or stall after 4 completed events while workers are healthy in timebox", async () => {
    const clock = { t: t0 + 1000 };
    const { p } = ports();
    const c = new NudgeController(p, { now: () => clock.t });
    const healthy = run({
      next: { kind: "wait" },
      associated: true,
      nodes: [{ dispatch_state: "running", started_at: t0, timebox_ms: IDLE_MS * 10 }],
    });
    for (let i = 0; i < 4; i++) {
      const out = await c.onTurnEnd(healthy, { endReason: "completed" });
      expect(out.action).toBe("skip");
      expect(out.reason).toBe("healthy_running");
    }
    expect(p.log.continue).toHaveLength(0);
    expect(p.log.notes).toHaveLength(0);
    expect(c.stateOf("run-1").stalled).toBe(false);
    expect(c.stateOf("run-1").consecutiveWithoutProgress).toBe(0);
  });
});

describe("card interval", () => {
  it("cardOnly ticks within 10s only present the card once", async () => {
    const clock = { t: t0 + IDLE_MS };
    const { p } = ports();
    const c = new NudgeController(p, { now: () => clock.t, cardOnly: true });
    const r = run({ associated: true });
    expect((await c.maybeNudge(r)).action).toBe("card");
    clock.t += 1;
    expect((await c.maybeNudge(r)).reason).toBe("card_interval");
    clock.t += 1;
    expect((await c.maybeNudge(r)).reason).toBe("card_interval");
    expect(p.log.cards).toHaveLength(1);
    expect(p.log.continue).toHaveLength(0);
  });

  it("the same version never re-shows the card, however long it waits; a new version does", async () => {
    const clock = { t: t0 + IDLE_MS };
    const { p } = ports();
    const c = new NudgeController(p, { now: () => clock.t, cardOnly: true });
    expect((await c.maybeNudge(run({ associated: true }))).action).toBe("card");
    clock.t += 60 * 60_000;
    expect((await c.maybeNudge(run({ associated: true }))).reason).toBe("card_interval");
    expect(p.log.cards).toHaveLength(1);
    expect((await c.maybeNudge(run({ associated: true, version: 2 }))).action).toBe("card");
    expect(p.log.cards).toHaveLength(2);
  });
});

describe("fairness waits only for runs asking in the current send window", () => {
  function setup(refuseA = true) {
    const clock = { t: t0 + IDLE_MS };
    const { p } = ports();
    const calls: string[] = [];
    let release: (() => void) | null = null;
    p.continueSession = async (req) => {
      calls.push(String(req.sessionId));
      if (req.sessionId === "sess-hold") await new Promise<void>((r) => (release = r));
      return refuseA && req.sessionId === "sess-a" ? { ok: false, errorCode: "SESSION_UNAVAILABLE" } : { ok: true, status: "queued" };
    };
    const c = new NudgeController(p, { now: () => clock.t });
    const a = run({ run_id: "run-a", associated: true, session_id: "sess-a" });
    const b = run({ run_id: "run-b", associated: true, session_id: "sess-b" });
    return { clock, c, a, b, calls, release: () => release?.() };
  }

  it("a run that stopped asking does not block others", async () => {
    const { clock, c, a, b, calls } = setup(false);
    expect((await c.maybeNudge(a)).action).toBe("continue");
    clock.t += NUDGE_INTERVAL_MS;
    expect((await c.maybeNudge(b)).action).toBe("continue");
    clock.t += NUDGE_INTERVAL_MS;
    // A never asks again.
    expect((await c.maybeNudge(b)).action).toBe("continue");
    expect(calls).toEqual(["sess-a", "sess-b", "sess-b"]);
  });

  it("slow clock: A refused, B served (30s rounds)", async () => {
    const { clock, c, a, b, calls } = setup();
    for (let round = 0; round < 8; round++) {
      await c.maybeNudge(a);
      await c.maybeNudge(b);
      clock.t += 30_000;
    }
    expect(calls.filter((x) => x === "sess-b").length).toBeGreaterThanOrEqual(3);
    expect(calls.filter((x) => x === "sess-a").length).toBeGreaterThanOrEqual(3);
  });

  it("repeated interval skips from A never push out a waiting B", async () => {
    const { clock, c, a, b, calls } = setup();
    for (let round = 0; round < 8; round++) {
      await c.maybeNudge(a);
      await c.maybeNudge(b);
      for (let k = 0; k < 7; k++) await c.maybeNudge(a);
      clock.t += 30_000;
    }
    expect(calls.filter((x) => x === "sess-b").length).toBeGreaterThanOrEqual(3);
  });

  it("repeated busy skips from A never push out a waiting B", async () => {
    const { clock, c, b, calls, release } = setup();
    const hold = run({ run_id: "run-h", associated: true, session_id: "sess-hold" });
    const pending = c.maybeNudge(hold);
    expect((await c.maybeNudge(b)).reason).toBe("busy");
    const a = run({ run_id: "run-a", associated: true, session_id: "sess-a" });
    for (let k = 0; k < 7; k++) expect((await c.maybeNudge(a)).reason).toBe("busy");
    release();
    await pending;
    clock.t += NUDGE_INTERVAL_MS;
    // B asked in this window before A, and has never been tried: B goes first.
    expect((await c.maybeNudge(a)).reason).toBe("fairness");
    expect((await c.maybeNudge(b)).action).toBe("continue");
    expect(calls).toEqual(["sess-hold", "sess-b"]);
  });

  it("a waiter that asked this window and then stopped being driven is dropped by syncActive", async () => {
    const { clock, c, a, b, calls } = setup(false);
    expect((await c.maybeNudge(a)).action).toBe("continue");
    clock.t += 1;
    // B asks in the new window (interval), so it is the fairest waiter; then B is deleted.
    expect((await c.maybeNudge(b)).reason).toBe("interval");
    clock.t += NUDGE_INTERVAL_MS;
    expect((await c.maybeNudge(a)).reason).toBe("fairness");
    c.syncActive(["run-a"]);
    expect((await c.maybeNudge(a)).action).toBe("continue");
    expect(calls).toEqual(["sess-a", "sess-a"]);
  });

  it("clock scan calls syncActive once with the full driven set before scanning each run", async () => {
    const { clock, c, a, b } = setup(false);
    const done = run({ run_id: "run-done", status: "done", associated: true, session_id: "sess-done" });
    const paused = run({ run_id: "run-paused", status: "paused", associated: true, session_id: "sess-paused" });
    const seen: string[][] = [];
    const real = c.syncActive.bind(c);
    c.syncActive = (ids) => {
      seen.push([...ids]);
      real(ids);
    };
    const outcomes = await scanNudgeClock(c, [a, done, b, paused]);
    expect(seen).toEqual([["run-a", "run-b"]]);
    expect(outcomes).toHaveLength(2);
    clock.t += NUDGE_INTERVAL_MS;
    const second = await scanNudgeClock(c, [a, b]);
    expect(seen[1]).toEqual(["run-a", "run-b"]);
    expect(second).toHaveLength(2);
  });
  it("fairness, busy, or interval skips do not abort the rest of the clock pass", async () => {
    const { clock, c, a, b, calls } = setup(false);
    expect((await c.maybeNudge(a)).action).toBe("continue");
    clock.t += 1;
    const outcomes = await scanNudgeClock(c, [a, b]);
    expect(outcomes.map((o) => o.reason)).toEqual(["interval", "interval"]);
    expect(outcomes).toHaveLength(2);
    clock.t += NUDGE_INTERVAL_MS;
    const next = await scanNudgeClock(c, [a, b]);
    expect(next).toHaveLength(2);
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
  it("a paused waiter gives up its turn instead of blocking the window", async () => {
    const { clock, c, a, b, calls } = setup(false);
    expect((await c.maybeNudge(a)).action).toBe("continue");
    clock.t += 1;
    expect((await c.maybeNudge(b)).reason).toBe("interval");
    expect(await c.handleCardAction({ actionId: PAUSE_RUN, run_id: "run-b" } as never)).toMatchObject({ ok: true, action: "pause" });
    clock.t += NUDGE_INTERVAL_MS;
    expect((await c.maybeNudge(a)).action).toBe("continue");
    expect(calls).toEqual(["sess-a", "sess-a"]);
  });
});
