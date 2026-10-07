import { describe, expect, it } from "vitest";
import { advance } from "../../src/main/graph/interpreter.ts";
import { ACCEPTED_TIMEOUT_MS, MAX_RECONCILE_ROUNDS, PLANNED_TIMEOUT_MS } from "../../src/main/graph/state.ts";
import { boot, readState, setupOk } from "./helpers.ts";

describe("dispatch recovery interrupts", () => {
  it("before persist there is no dispatch_key; after persist there is exactly one", async () => {
    const { h, spec } = await boot();
    expect(readState(h).nodes.worker).toBeUndefined();
    const d = await setupOk(h, spec);
    expect(d.next.kind).toBe("dispatch");
    if (d.next.kind !== "dispatch") throw new Error("dispatch");
    expect(readState(h).nodes.worker?.dispatch_key).toBe("run1:worker:1");
    expect(readState(h).nodes.worker?.dispatch_state).toBe("planned");
  });

  it("created but not delivered goes to reconciling, not a second create", async () => {
    const { h, spec } = await boot();
    const d = await setupOk(h, spec);
    if (d.next.kind !== "dispatch") throw new Error("dispatch");
    const r = await advance(h, "run1", {
      type: "report",
      phase: "accepted",
      dispatch_key: d.next.dispatch_key,
      worker_id: "w1",
      dispatch_outcome: { created: true, delivered: false, queued: false },
    }, { spec });
    expect(["reconcile", "wait"]).toContain(r.next.kind);
    const st = readState(h);
    expect(st.nodes.worker?.attempts).toBe(1);
    expect(st.nodes.worker?.dispatch_key).toBe(d.next.dispatch_key);
  });

  it("queued stays accepted until the message leaves the queue", async () => {
    const { h, spec } = await boot();
    const d = await setupOk(h, spec);
    if (d.next.kind !== "dispatch") throw new Error("dispatch");
    const q = await advance(h, "run1", {
      type: "report",
      phase: "accepted",
      dispatch_key: d.next.dispatch_key,
      worker_id: "w1",
      worker_session_id: "ws1",
      queued_message_id: "qm1",
      dispatch_outcome: { created: true, delivered: false, queued: true },
    }, { spec });
    expect(q.next.kind).toBe("wait");
    expect(readState(h).nodes.worker?.dispatch_state).toBe("accepted");
    h.clock.t += ACCEPTED_TIMEOUT_MS;
    const rec = await advance(h, "run1", { type: "tick" }, { spec });
    expect(rec.next.kind).toBe("reconcile");
  });

  it("late and duplicate finals of an old attempt do not advance the current attempt", async () => {
    const { h, spec, opts } = await boot();
    const d = await setupOk(h, spec);
    if (d.next.kind !== "dispatch") throw new Error("dispatch");
    const key1 = d.next.dispatch_key;
    await advance(h, "run1", {
      type: "report", phase: "accepted", dispatch_key: key1,
      worker_id: "w1", worker_session_id: "ws1", dispatch_outcome: { created: true, delivered: true, queued: false },
    }, opts);
    h.clock.t += 5 * 60 * 1000;
    const diag = await advance(h, "run1", { type: "tick" }, { ...opts, gates: { retry: () => "retry" } });
    expect(diag.next.kind).toBe("recover");
    await advance(h, "run1", { type: "report", phase: "recover", dispatch_key: key1, action: "diagnose", action_result: { running: true } }, { ...opts, gates: { retry: () => "retry" } });
    await advance(h, "run1", { type: "report", phase: "recover", dispatch_key: key1, action: "archive", action_result: { ok: true } }, opts);
    await advance(h, "run1", { type: "report", phase: "recover", dispatch_key: key1, action: "verify_stopped", action_result: { ok: true, complete: true, stopped: true } }, opts);
    const d2 = await advance(h, "run1", { type: "tick" }, opts);
    expect(d2.next.kind).toBe("dispatch");
    if (d2.next.kind !== "dispatch") throw new Error("dispatch2");
    expect(d2.next.dispatch_key).toBe("run1:worker:2");
    const late = await advance(h, "run1", { type: "report", phase: "final", dispatch_key: key1, inline_report: { status: "done" } }, opts);
    expect(late.next.kind).toBe("dispatch");
    if (late.next.kind !== "dispatch") throw new Error("still 2");
    expect(late.next.dispatch_key).toBe("run1:worker:2");
    expect(readState(h).late_reports.some((r) => r.dispatch_key === key1)).toBe(true);
    expect(readState(h).cursor).toBe("worker");
  });

  it("plugin task missing receipts reconciling queries getRun instead of replaying create", async () => {
    const { h, spec, opts } = await boot();
    const d = await setupOk(h, spec);
    if (d.next.kind !== "dispatch") throw new Error("dispatch");
    await advance(h, "run1", {
      type: "report", phase: "accepted", dispatch_key: d.next.dispatch_key,
      worker_id: "w", worker_session_id: "ws", dispatch_outcome: { created: true, delivered: true, queued: false },
    }, opts);
    await advance(h, "run1", { type: "report", phase: "final", dispatch_key: d.next.dispatch_key, inline_report: { status: "done" } }, opts);
    await advance(h, "run1", { type: "wait_done", on: "ok" }, opts);
    const create = await advance(h, "run1", { type: "tick" }, opts);
    expect(create.next.kind).toBe("dispatch");
    if (create.next.kind !== "dispatch") throw new Error("plugin");
    const key = create.next.dispatch_key;
    h.clock.t += PLANNED_TIMEOUT_MS;
    const rec = await advance(h, "run1", { type: "tick" }, opts);
    expect(rec.next.kind).toBe("reconcile");
    if (rec.next.kind !== "reconcile") throw new Error("reconcile");
    expect(rec.next.dispatch_key).toBe(key);
    expect(rec.next.queries.some((q) => q.tool === "getRun")).toBe(true);
    expect(rec.next.queries.some((q) => q.tool === "list_workers")).toBe(false);
  });

  it("lost send_initial receipt does not send the same text again", async () => {
    const { h, spec, opts } = await boot();
    const d = await setupOk(h, spec);
    if (d.next.kind !== "dispatch") throw new Error("dispatch");
    const key = d.next.dispatch_key;
    h.clock.t += PLANNED_TIMEOUT_MS;
    await advance(h, "run1", { type: "tick" }, opts);
    const send = await advance(h, "run1", {
      type: "report",
      phase: "reconcile",
      dispatch_key: key,
      queries_result: {
        list_workers: { ok: true, complete: true, team_id: "team-1", workers: [{ label: readState(h).nodes.worker!.worker_label!, worker_id: "w1", worker_session_id: "ws1", status: "idle" }] },
        get_worker_queue_status: { ok: true, pending: [], consuming: null },
      },
    }, opts);
    expect(send.next.kind).toBe("recover");
    if (send.next.kind !== "recover") throw new Error("send_initial");
    expect(send.next.action).toBe("send_initial");
    expect(readState(h).nodes.worker?.send_initial_attempted).toBe(true);
    const lost = await advance(h, "run1", {
      type: "report", phase: "recover", dispatch_key: key, action: "send_initial", action_result: { ok: false, errorCode: "TIMEOUT" },
    }, opts);
    expect(lost.next.kind).not.toBe("recover");
    const again = await advance(h, "run1", { type: "tick" }, opts);
    if (again.next.kind === "recover") expect(again.next.action).not.toBe("send_initial");
  });

  it("archive then unverified stop opens a human gate instead of a new attempt", async () => {
    const { h, spec, opts } = await boot();
    const d = await setupOk(h, spec);
    if (d.next.kind !== "dispatch") throw new Error("dispatch");
    const key = d.next.dispatch_key;
    await advance(h, "run1", {
      type: "report", phase: "accepted", dispatch_key: key,
      worker_id: "w1", worker_session_id: "ws1", dispatch_outcome: { created: true, delivered: true, queued: false },
    }, opts);
    h.clock.t += 5 * 60 * 1000;
    await advance(h, "run1", { type: "tick" }, { ...opts, gates: { retry: () => "retry" } });
    await advance(h, "run1", { type: "report", phase: "recover", dispatch_key: key, action: "diagnose", action_result: { running: true } }, { ...opts, gates: { retry: () => "retry" } });
    const arch = await advance(h, "run1", { type: "report", phase: "recover", dispatch_key: key, action: "archive", action_result: { ok: true } }, opts);
    expect(arch.next.kind).toBe("recover");
    if (arch.next.kind !== "recover") throw new Error("verify");
    expect(arch.next.action).toBe("verify_stopped");
    const human = await advance(h, "run1", {
      type: "report", phase: "recover", dispatch_key: key, action: "verify_stopped", action_result: { ok: true, complete: false },
    }, opts);
    expect(human.next.kind).toBe("decide");
    expect(human.state.status).toBe("waiting_human");
    expect(readState(h).nodes.worker?.dispatch_key).toBe(key);
  });

  it("incomplete list_workers is not an empty list; 3 uncertain rounds open a human gate", async () => {
    const { h, spec, opts } = await boot();
    const d = await setupOk(h, spec);
    if (d.next.kind !== "dispatch") throw new Error("dispatch");
    const key = d.next.dispatch_key;
    h.clock.t += PLANNED_TIMEOUT_MS;
    await advance(h, "run1", { type: "tick" }, opts);
    for (let i = 0; i < MAX_RECONCILE_ROUNDS; i++) {
      const r = await advance(h, "run1", {
        type: "report",
        phase: "reconcile",
        dispatch_key: key,
        queries_result: { list_workers: { ok: false, errorCode: "HOST_NOT_READY" } },
      }, opts);
      if (i < MAX_RECONCILE_ROUNDS - 1) expect(r.next.kind).toBe("reconcile");
      else {
        expect(r.next.kind).toBe("decide");
        expect(r.state.status).toBe("waiting_human");
      }
    }
    expect(readState(h).nodes.worker?.attempts).toBe(1);
  });
});
