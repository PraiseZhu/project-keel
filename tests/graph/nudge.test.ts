import { describe, expect, it } from "vitest";
import {
  ENABLE_AUTOPILOT,
  PAUSE_RUN,
  TOKEN_TTL_MS,
  consumeUserActionToken,
  handleCardAction,
  issueUserActionToken,
  newTokenBook,
  renderNudgeCard,
} from "../../src/main/graph/cards.ts";
import {
  IDLE_MS,
  NUDGE_INTERVAL_MS,
  NudgeController,
  nudgePrompt,
  onlyHealthyRunning,
  pendingLeadAction,
  shouldNudge,
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
  const log: { continue: string[]; cards: string[]; notes: string[] } = { continue: [], cards: [], notes: [] };
  let hang: ((v: { ok: boolean; errorCode?: string }) => void) | null = null;
  const p: NudgePorts & { log: typeof log; release: (v: { ok: boolean; errorCode?: string }) => void } = {
    log,
    async continueSession(req) {
      log.continue.push(req.prompt);
      if (hangWaiters.useHang) {
        return new Promise((resolve) => { hang = resolve; });
      }
      return hangWaiters.next ?? { ok: true, status: "resumed" };
    },
    presentCard(card) { log.cards.push(card.run_id + ":" + card.buttons.map((b) => b.label).join(",")); },
    notifyUser(message) { log.notes.push(message); },
    release(v) { hang?.(v); hang = null; },
  };
  const hangWaiters: { useHang: boolean; next: { ok: boolean; errorCode?: string; message?: string } | null } = { useHang: false, next: null };
  return { p, hangWaiters };
}

describe("NudgeController queue and streak", () => {
  it("sends the fixed prompt and enforces one-in-flight plus ≥10s gap", async () => {
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
    expect(p.log.continue[0]).toBe(nudgePrompt("run-1"));
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

describe("cards and userActionToken", () => {
  it("renders the two required buttons", () => {
    const card = renderNudgeCard("run-1");
    expect(card.buttons.map((b) => b.label)).toEqual(["启用自动续跑", "暂停"]);
    expect(card.buttons.map((b) => b.id)).toEqual([ENABLE_AUTOPILOT, PAUSE_RUN]);
  });
  it("accepts a token once within two minutes, and never from background", () => {
    const book = newTokenBook();
    const tok = issueUserActionToken(book, "run-1", t0, "tok-1");
    expect(handleCardAction(book, { action: ENABLE_AUTOPILOT, token: tok.token, run_id: "run-1", now: t0 })).toMatchObject({ ok: true, action: "associate" });
    expect(handleCardAction(book, { action: ENABLE_AUTOPILOT, token: tok.token, run_id: "run-1", now: t0 }).ok).toBe(false);
    const tok2 = issueUserActionToken(book, "run-1", t0, "tok-2");
    expect(consumeUserActionToken(book, tok2.token, t0, { run_id: "run-1", background: true }).ok).toBe(false);
    const tok3 = issueUserActionToken(book, "run-1", t0, "tok-3");
    expect(consumeUserActionToken(book, tok3.token, t0 + TOKEN_TTL_MS + 1, { run_id: "run-1" }).ok).toBe(false);
    const tok4 = issueUserActionToken(book, "run-1", t0, "tok-4");
    expect(handleCardAction(book, { action: PAUSE_RUN, token: tok4.token, run_id: "run-1", now: t0 })).toMatchObject({ ok: true, action: "pause" });
  });
  it("controller associates on enable and pauses on pause", () => {
    const { p } = ports();
    const c = new NudgeController(p, { now: () => t0 });
    const enable = issueUserActionToken(c.tokens, "run-1", t0, "e");
    expect(c.handleCardAction({ action: ENABLE_AUTOPILOT, token: enable.token, run_id: "run-1", now: t0 })).toMatchObject({ ok: true, action: "associate" });
    expect(c.stateOf("run-1").associated).toBe(true);
    const pause = issueUserActionToken(c.tokens, "run-1", t0, "p");
    expect(c.handleCardAction({ action: PAUSE_RUN, token: pause.token, run_id: "run-1", now: t0 })).toMatchObject({ ok: true, action: "pause" });
    expect(c.stateOf("run-1").associated).toBe(false);
  });
});
