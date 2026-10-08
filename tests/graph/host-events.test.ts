import { describe, expect, it } from "vitest";
import { ENABLE_AUTOPILOT, cardUpdateMessage, parseCardActionEvent, parseTurnEndEvent, renderNudgeCard, runIdFromCardAction } from "../../src/main/graph/cards.ts";
import type { AgentRunResult, AssociateSessionReq, ContinueSessionReq, NudgePorts } from "../../src/main/graph/nudge.ts";
import { NudgeController, onlyHealthyRunning, shouldNudge } from "../../src/main/graph/nudge.ts";
import {
  asNudgeRun,
  flushNudgeCardOnToolCall,
  handleCardActionMessage,
  handleTurnEndMessage,
  isNodeClockNotification,
  presentNudgeCard,
  rememberCardCallId,
  scanDrivenRuns,
  tickNudgeClockFor,
} from "../../src/main/host-bridge.ts";
import { fakeHost } from "../helpers/fakeHost.ts";

const t0 = Date.UTC(2026, 9, 7, 12, 0, 0);
const REAL_CALL_ID = "tc_7f3a9c2e-host-opaque";

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

function seedRun(host: ReturnType<typeof fakeHost>, runId: string, over: Record<string, unknown> = {}) {
  host.files.set(
    `runs/${runId}/graph-state.json`,
    JSON.stringify({
      run_id: runId,
      status: "running",
      next: { kind: "dispatch" },
      updated_at: t0,
      nodes: {},
      ...over,
    }),
  );
}

describe("handbook host events and cards", () => {
  it("uses a real tool-call callId; opaque click callId resolves run_id and forwards the token", async () => {
    const { p } = ports();
    const c = new NudgeController(p, { now: () => t0 });
    const host = fakeHost();
    seedRun(host, "run-1");
    const sent: unknown[] = [];
    const shown = await flushNudgeCardOnToolCall({
      host,
      send: (m) => sent.push(m),
      tool: "keel_status",
      callId: REAL_CALL_ID,
      args: { run_id: "run-1" },
      result: { run_id: "run-1" },
    });
    expect(shown).toBe(true);
    const cardMsg = sent[0] as ReturnType<typeof cardUpdateMessage>;
    expect(cardMsg.type).toBe("card-update");
    expect(cardMsg.callId).toBe(REAL_CALL_ID);
    expect(cardMsg.callId.startsWith("keel-nudge-")).toBe(false);
    expect(cardMsg.html).toContain('data-ghost-action="enable_autopilot"');

    const token = "host-issued-uat-abc";
    const msg = {
      type: "event",
      name: "card-action",
      callId: REAL_CALL_ID,
      actionId: ENABLE_AUTOPILOT,
      sessionId: "sess-1",
      userActionToken: token,
    };
    expect(parseCardActionEvent(msg)?.callId).toBe(REAL_CALL_ID);
    expect(runIdFromCardAction(parseCardActionEvent(msg)!)).toBeUndefined();
    const r = await handleCardActionMessage(c, host, msg);
    expect(r.handled).toBe(true);
    expect(r.result).toMatchObject({ ok: true, action: "associate", status: "created", run_id: "run-1" });
    expect(p.log.associate[0]?.userActionToken).toBe(token);
    expect(p.log.associate[0]?.event).toEqual({ actionId: ENABLE_AUTOPILOT, callId: REAL_CALL_ID });
  });

  it("interrupted for session-a pauses only run-a; run-b stays running", async () => {
    const { p } = ports();
    const c = new NudgeController(p, { now: () => t0 + 10 * 60_000 });
    const host = fakeHost();
    seedRun(host, "run-a", { sol_session_id: "session-a" });
    seedRun(host, "run-b", { sol_session_id: "session-b" });
    const logs: string[] = [];
    const mapped = [
      asNudgeRun(JSON.parse(host.files.get("runs/run-a/graph-state.json")!))!,
      asNudgeRun(JSON.parse(host.files.get("runs/run-b/graph-state.json")!))!,
    ];
    const msg = { type: "event", name: "did-turn-end", data: { endReason: "interrupted", sessionId: "session-a" } };
    expect(parseTurnEndEvent(msg)).toEqual({ endReason: "interrupted", sessionId: "session-a" });
    const turn = await handleTurnEndMessage(c, host, mapped, msg, (line) => logs.push(line));
    expect(turn).toEqual({ handled: true, paused: ["run-a"] });
    expect(JSON.parse(host.files.get("runs/run-a/graph-state.json")!).status).toBe("paused");
    expect(JSON.parse(host.files.get("runs/run-b/graph-state.json")!).status).toBe("running");
    expect(logs).toHaveLength(0);
  });

  it("missing sessionId pauses no runs and logs", async () => {
    const { p } = ports();
    const c = new NudgeController(p, { now: () => t0 + 10 * 60_000 });
    const host = fakeHost();
    seedRun(host, "run-a", { sol_session_id: "session-a" });
    const logs: string[] = [];
    const mapped = [asNudgeRun(JSON.parse(host.files.get("runs/run-a/graph-state.json")!))!];
    const turn = await handleTurnEndMessage(
      c,
      host,
      mapped,
      { type: "event", name: "did-turn-end", data: { endReason: "interrupted" } },
      (line) => logs.push(line),
    );
    expect(turn).toEqual({ handled: true, paused: [] });
    expect(JSON.parse(host.files.get("runs/run-a/graph-state.json")!).status).toBe("running");
    expect(logs.some((l) => /missing sessionId/.test(l))).toBe(true);
  });

  it("a Node clock.tick notification is the resident clock event", () => {
    expect(isNodeClockNotification({ type: "event", name: "node-notification", method: "clock.tick" })).toBe(true);
    expect(isNodeClockNotification({ type: "nudge-clock" })).toBe(false);
    expect(isNodeClockNotification({ type: "event", name: "node-notification", method: "progress" })).toBe(false);
  });

  it("scanDrivenRuns uses the same nudge limits as the clock", async () => {
    const { p } = ports();
    const host = fakeHost();
    host.clock.t = t0 + 10 * 60_000;
    seedRun(host, "run-1", { updated_at: t0, sol_session_id: "s1" });
    const c = new NudgeController(p, { now: () => host.clock.t });
    await scanDrivenRuns(c, host);
    expect(JSON.parse(host.files.get("runs/run-1/graph-state.json")!).nudge_pending_card).toBe(true);
    const first = p.log.continue.length;
    await scanDrivenRuns(c, host);
    expect(p.log.continue.length).toBe(first);
  });

  it("clock without a real card slot does not send card-update, only records pending", async () => {
    const { p } = ports();
    const c = new NudgeController(p, { now: () => t0 + 10 * 60_000 });
    const host = fakeHost();
    seedRun(host, "run-1");
    await tickNudgeClockFor(c, host, [asNudgeRun(JSON.parse(host.files.get("runs/run-1/graph-state.json")!))!]);
    const persisted = JSON.parse(host.files.get("runs/run-1/graph-state.json")!);
    expect(persisted.nudge_pending_card).toBe(true);
    expect(persisted.status).not.toBe("paused");
  });

  it("presentNudgeCard without a real callId sends nothing", () => {
    const sent: unknown[] = [];
    expect(presentNudgeCard((m) => sent.push(m), renderNudgeCard("run-1"), undefined)).toBe(false);
    expect(sent).toHaveLength(0);
    expect(presentNudgeCard((m) => sent.push(m), renderNudgeCard("run-1"), REAL_CALL_ID)).toBe(true);
    expect((sent[0] as { callId: string }).callId).toBe(REAL_CALL_ID);
  });

  it("stalled persisted status is excluded from syncActive/clock", async () => {
    const { p } = ports();
    const c = new NudgeController(p, { now: () => t0 + 10 * 60_000 });
    const host = fakeHost();
    seedRun(host, "run-1", { status: "stalled" });
    await tickNudgeClockFor(c, host, [asNudgeRun(JSON.parse(host.files.get("runs/run-1/graph-state.json")!))!]);
    expect(p.log.continue).toHaveLength(0);
  });

  it("asNudgeRun fills timebox_ms from the graph spec so a late running node is nudged", async () => {
    const { p } = ports();
    const started = t0;
    const host = fakeHost();
    host.clock.t = started + 2 * 60 * 60_000;
    seedRun(host, "run-tb", {
      spec_id: "bug-fix",
      task_type: "bug-fix",
      status: "running",
      next: { kind: "wait" },
      updated_at: started,
      nodes: {
        "verify-head": {
          status: "active",
          dispatch_state: "running",
          started_at: started,
        },
      },
    });
    const mapped = asNudgeRun(JSON.parse(host.files.get("runs/run-tb/graph-state.json")!))!;
    expect(mapped.nodes?.[0]?.timebox_ms).toBe(40 * 60_000);
    expect(onlyHealthyRunning(mapped, host.clock.t)).toBe(false);
    expect(shouldNudge(mapped, host.clock.t).nudge).toBe(true);
    const c = new NudgeController(p, { now: () => host.clock.t });
    await tickNudgeClockFor(c, host, [mapped]);
    expect(JSON.parse(host.files.get("runs/run-tb/graph-state.json")!).nudge_pending_card).toBe(true);
  });

  it("remembered mapping still resolves after a later tool-call", async () => {
    const host = fakeHost();
    seedRun(host, "run-1");
    await rememberCardCallId(host, "run-1", REAL_CALL_ID);
    const { p } = ports();
    const c = new NudgeController(p, { now: () => t0 });
    const r = await handleCardActionMessage(c, host, {
      type: "event",
      name: "card-action",
      callId: REAL_CALL_ID,
      actionId: ENABLE_AUTOPILOT,
      userActionToken: "tok",
    });
    expect(r.result).toMatchObject({ ok: true, run_id: "run-1" });
  });
});
