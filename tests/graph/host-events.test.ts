import { describe, expect, it } from "vitest";
import { ENABLE_AUTOPILOT, cardUpdateMessage, parseCardActionEvent, parseTurnEndEvent, renderNudgeCard, runIdFromCardAction } from "../../src/main/graph/cards.ts";
import type { AgentRunResult, AssociateSessionReq, ContinueSessionReq, NudgePorts } from "../../src/main/graph/nudge.ts";
import { NudgeController } from "../../src/main/graph/nudge.ts";
import { asNudgeRun, handleCardActionMessage, handleTurnEndMessage, presentNudgeCard, tickNudgeClockFor } from "../../src/main/host-bridge.ts";
import { fakeHost } from "../helpers/fakeHost.ts";

const t0 = Date.UTC(2026, 9, 7, 12, 0, 0);

function ports() {
  const log: { associate: AssociateSessionReq[]; continue: ContinueSessionReq[]; cards: unknown[] } = {
    associate: [],
    continue: [],
    cards: [],
  };
  const hangWaiters: { next: AgentRunResult | null } = { next: null };
  const p: NudgePorts & { log: typeof log } = {
    log,
    async associateSession(req) {
      log.associate.push(req);
      return hangWaiters.next ?? { ok: true, status: "created" };
    },
    async continueSession(req) {
      log.continue.push(req);
      return hangWaiters.next ?? { ok: true, status: "resumed" };
    },
    presentCard(card) {
      log.cards.push(card);
    },
    notifyUser() {},
  };
  return { p };
}

function seedRun(host: ReturnType<typeof fakeHost>, over: Record<string, unknown> = {}) {
  host.files.set(
    "runs/run-1/graph-state.json",
    JSON.stringify({
      run_id: "run-1",
      status: "running",
      next: { kind: "dispatch" },
      updated_at: t0,
      nodes: {},
      ...over,
    }),
  );
}

describe("handbook host events and cards", () => {
  it("card-action event establishes association and forwards the host token as-is", async () => {
    const { p } = ports();
    const c = new NudgeController(p, { now: () => t0 });
    const host = fakeHost();
    const token = "host-issued-uat-abc";
    const msg = {
      type: "event",
      name: "card-action",
      callId: "keel-nudge-run-1",
      actionId: ENABLE_AUTOPILOT,
      sessionId: "sess-1",
      userActionToken: token,
    };
    expect(parseCardActionEvent(msg)?.userActionToken).toBe(token);
    expect(runIdFromCardAction(parseCardActionEvent(msg)!)).toBe("run-1");
    const r = await handleCardActionMessage(c, host, msg);
    expect(r.handled).toBe(true);
    expect(r.result).toMatchObject({ ok: true, action: "associate", status: "created", run_id: "run-1" });
    expect(p.log.associate[0]?.userActionToken).toBe(token);
    expect(p.log.associate[0]?.event).toEqual({ actionId: ENABLE_AUTOPILOT, callId: "keel-nudge-run-1" });
  });

  it("did-turn-end interrupted persists paused and later clocks skip continueSession", async () => {
    const { p } = ports();
    const c = new NudgeController(p, { now: () => t0 + 10 * 60_000 });
    const host = fakeHost();
    seedRun(host);
    const msg = { type: "event", name: "did-turn-end", data: { endReason: "interrupted" } };
    expect(parseTurnEndEvent(msg)).toEqual({ endReason: "interrupted" });
    const mapped = [asNudgeRun(JSON.parse(host.files.get("runs/run-1/graph-state.json")!))!];
    const turn = await handleTurnEndMessage(c, host, mapped, msg);
    expect(turn.handled).toBe(true);
    expect(p.log.continue).toHaveLength(0);
    const persisted = JSON.parse(host.files.get("runs/run-1/graph-state.json")!);
    expect(persisted.status).toBe("paused");
    const after = [asNudgeRun(persisted)!];
    await tickNudgeClockFor(c, host, after);
    expect(p.log.continue).toHaveLength(0);
    expect(p.log.cards).toHaveLength(0);
  });

  it("stalled persisted status is excluded from syncActive/clock", async () => {
    const { p } = ports();
    const c = new NudgeController(p, { now: () => t0 + 10 * 60_000 });
    const host = fakeHost();
    seedRun(host, { status: "stalled" });
    await tickNudgeClockFor(c, host, [asNudgeRun(JSON.parse(host.files.get("runs/run-1/graph-state.json")!))!]);
    expect(p.log.continue).toHaveLength(0);
    expect(p.log.cards).toHaveLength(0);
  });

  it("emits card-update with callId and data-ghost-action html", () => {
    const sent: unknown[] = [];
    const card = renderNudgeCard("run-1");
    presentNudgeCard((m) => sent.push(m), card);
    const msg = sent[0] as ReturnType<typeof cardUpdateMessage>;
    expect(msg.type).toBe("card-update");
    expect(msg.callId).toBe("keel-nudge-run-1");
    expect(msg.html).toContain("data-ghost-action=\"enable_autopilot\"");
    expect(msg.html).toContain("data-ghost-action=\"pause\"");
    expect(msg.html).not.toMatch(/<script|onclick=/i);
  });
});
