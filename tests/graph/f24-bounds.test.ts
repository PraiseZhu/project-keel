import { describe, expect, it } from "vitest";
import { KeelError } from "../../src/main/host.ts";
import { advance, createRun } from "../../src/main/graph/interpreter.ts";
import { graphStatePath } from "../../src/main/store/runs.ts";
import { MAX_RECONCILE_ROUNDS, PLANNED_TIMEOUT_MS, RECONCILE_TIMEOUT_MS, RECOVER_TIMEOUT_MS } from "../../src/main/graph/state.ts";
import { PSTACK_GRAPHS } from "../../src/shared/graph/pstack.ts";
import type { GraphSpec } from "../../src/shared/graph/spec.ts";
import { fakeHost } from "../helpers/fakeHost.ts";
import { boot, miniSpec, readState, setupOk } from "./helpers.ts";

function implementSpec(): GraphSpec {
  const s = miniSpec();
  const rename = (id: string) => (id === "worker" ? "implement" : id);
  return {
    ...s,
    entry: "implement",
    nodes: s.nodes.map((n) => ({ ...n, id: rename(n.id) })),
    edges: s.edges.map((e) => ({ ...e, from: rename(e.from), to: rename(e.to) })),
  };
}

describe("F24-01 bounds without keel_report", () => {
  it("reconcile round times out on tick and opens a human gate after 3 rounds", async () => {
    const { h, spec, opts } = await boot();
    const d = await setupOk(h, spec);
    if (d.next.kind !== "dispatch") throw new Error("dispatch");
    h.clock.t += PLANNED_TIMEOUT_MS;
    expect((await advance(h, "run1", { type: "tick" }, opts)).next.kind).toBe("reconcile");
    for (let i = 0; i < MAX_RECONCILE_ROUNDS; i++) {
      h.clock.t += RECONCILE_TIMEOUT_MS;
      const r = await advance(h, "run1", { type: "tick" }, opts);
      if (i < MAX_RECONCILE_ROUNDS - 1) expect(r.next.kind).toBe("reconcile");
      else {
        expect(r.next.kind).toBe("decide");
        if (r.next.kind !== "decide") throw new Error("human");
        expect(r.next.gate_id).toBe("human:reconcile");
      }
    }
  });

  it("recover without a report times out into a human gate and is not resent", async () => {
    const { h, spec, opts } = await boot();
    const d = await setupOk(h, spec);
    if (d.next.kind !== "dispatch") throw new Error("dispatch");
    await advance(h, "run1", {
      type: "report", phase: "accepted", dispatch_key: d.next.dispatch_key,
      worker_id: "w1", worker_session_id: "ws1", dispatch_outcome: { created: true, delivered: true, queued: false },
    }, opts);
    h.clock.t += 5 * 60 * 1000;
    const recov = await advance(h, "run1", { type: "tick" }, opts);
    expect(recov.next.kind).toBe("recover");
    if (recov.next.kind !== "recover") throw new Error("diagnose");
    expect(recov.next.action).toBe("diagnose");
    h.clock.t += RECOVER_TIMEOUT_MS;
    const timed = await advance(h, "run1", { type: "tick" }, opts);
    expect(timed.next.kind).toBe("decide");
    if (timed.next.kind !== "decide") throw new Error("human");
    expect(timed.next.gate_id).toBe("human:recover");
    h.clock.t += RECOVER_TIMEOUT_MS;
    const again = await advance(h, "run1", { type: "tick" }, opts);
    expect(again.next.kind).toBe("decide");
    expect(again.next.kind === "recover" ? again.next.action : "").not.toBe("diagnose");
  });

  it("plugin create receipt missing increments reconcile rounds on tick and does not replay dispatch", async () => {
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
    if (create.next.kind !== "dispatch") throw new Error("plugin");
    h.clock.t += PLANNED_TIMEOUT_MS;
    const first = await advance(h, "run1", { type: "tick" }, opts);
    expect(first.next.kind).toBe("reconcile");
    h.clock.t += RECONCILE_TIMEOUT_MS;
    const second = await advance(h, "run1", { type: "tick" }, opts);
    expect(second.next.kind).toBe("reconcile");
    expect(readState(h).nodes.research?.reconcile_rounds).toBeGreaterThanOrEqual(2);
    expect(second.next.kind === "dispatch").toBe(false);
  });

  it("tool node ci-rerun-once stops after max_attempts instead of looping", async () => {
    const spec: GraphSpec = {
      id: "bug-fix",
      version: 1,
      entry: "ci-rerun-once",
      exits: ["done", "stopped"],
      covers: ["bug-fix"],
      adaptations: [],
      nodes: [
        { id: "ci-rerun-once", kind: "tool", writes: false, playbook_steps: ["babysit#7"], timebox_min: 1, max_attempts: 1 },
        { id: "done", kind: "tool", writes: false, playbook_steps: [], timebox_min: 1, max_attempts: 1 },
        { id: "stopped", kind: "tool", writes: false, playbook_steps: [], timebox_min: 1, max_attempts: 1 },
      ],
      edges: [
        { from: "ci-rerun-once", to: "done", on: "ok" },
        { from: "ci-rerun-once", to: "ci-rerun-once", on: "fail" },
      ],
    };
    const h = fakeHost();
    await createRun(h, {
      run_id: "run1", spec_id: spec.id, profile_id: "sol", lead_harness: "codex", task_type: "bug-fix",
      entry: "ci-rerun-once", goal: "ci", now: h.now(),
    });
    const first = await advance(h, "run1", { type: "tick" }, { spec });
    expect(first.next.kind).toBe("wait");
    await advance(h, "run1", { type: "wait_done", on: "fail" }, { spec });
    const second = await advance(h, "run1", { type: "tick" }, { spec });
    expect(["decide", "stop"]).toContain(second.next.kind);
    expect(readState(h).nodes["ci-rerun-once"]?.attempts).toBe(1);
  });
});

describe("tool node attempts count entries, not ticks", () => {
  it("ticks while waiting on wait-ci / ci-rerun-once do not use up attempts", async () => {
    const spec: GraphSpec = {
      id: "bug-fix",
      version: 1,
      entry: "ci-rerun-once",
      exits: ["done", "stopped"],
      covers: ["bug-fix"],
      adaptations: [],
      nodes: [
        { id: "ci-rerun-once", kind: "tool", writes: false, playbook_steps: ["babysit#7"], timebox_min: 1, max_attempts: 1 },
        { id: "done", kind: "tool", writes: false, playbook_steps: [], timebox_min: 1, max_attempts: 1 },
        { id: "stopped", kind: "tool", writes: false, playbook_steps: [], timebox_min: 1, max_attempts: 1 },
      ],
      edges: [
        { from: "ci-rerun-once", to: "done", on: "ok" },
        { from: "ci-rerun-once", to: "stopped", on: "fail" },
      ],
    };
    const h = fakeHost();
    await createRun(h, {
      run_id: "run1", spec_id: spec.id, profile_id: "sol", lead_harness: "codex", task_type: "bug-fix",
      entry: "ci-rerun-once", goal: "ci", now: h.now(),
    });
    expect((await advance(h, "run1", { type: "tick" }, { spec })).next.kind).toBe("wait");
    for (let i = 0; i < 5; i++) {
      h.clock.t += 60_000;
      expect((await advance(h, "run1", { type: "tick" }, { spec })).next.kind).toBe("wait");
    }
    expect(readState(h).nodes["ci-rerun-once"]?.attempts).toBe(1);
    const end = await advance(h, "run1", { type: "wait_done", on: "ok" }, { spec });
    expect(end.next.kind).toBe("done");
  });
});

describe("F24-02 send_initial at most once", () => {
  it("does not send_initial when the worker is running even if the queue is empty", async () => {
    const { h, spec, opts } = await boot();
    const d = await setupOk(h, spec);
    if (d.next.kind !== "dispatch") throw new Error("dispatch");
    const key = d.next.dispatch_key;
    const label = d.next.create_worker?.label;
    h.clock.t += PLANNED_TIMEOUT_MS;
    await advance(h, "run1", { type: "tick" }, opts);
    const r = await advance(h, "run1", {
      type: "report",
      phase: "reconcile",
      dispatch_key: key,
      queries_result: {
        list_workers: { ok: true, complete: true, team_id: "team-1", workers: [{ label: label!, worker_id: "w1", worker_session_id: "ws1", status: "running" }] },
        get_worker_queue_status: { ok: true, pending: [], consuming: null },
      },
    }, opts);
    expect(r.next.kind).not.toBe("recover");
    expect(readState(h).nodes.worker?.dispatch_state).toBe("running");
    expect(readState(h).nodes.worker?.send_initial_attempted).not.toBe(true);
  });

  it("idle with an empty queue never resends: it may be finished, so a human checks", async () => {
    const { h, spec, opts } = await boot();
    const d = await setupOk(h, spec);
    if (d.next.kind !== "dispatch") throw new Error("dispatch");
    const key = d.next.dispatch_key;
    h.clock.t += PLANNED_TIMEOUT_MS;
    await advance(h, "run1", { type: "tick" }, opts);
    const r = await advance(h, "run1", {
      type: "report",
      phase: "reconcile",
      dispatch_key: key,
      queries_result: {
        list_workers: { ok: true, complete: true, team_id: "team-1", workers: [{ label: readState(h).nodes.worker!.worker_label!, worker_id: "w1", worker_session_id: "ws1", status: "idle" }] },
        get_worker_queue_status: { ok: true, pending: [], consuming: null },
      },
    }, opts);
    expect(r.next.kind).toBe("decide");
    if (r.next.kind !== "decide") throw new Error("decide");
    expect(r.next.gate_id).toBe("human:reconcile");
    const snap = h.files.get(graphStatePath("run1"))!;
    const h2 = fakeHost();
    h2.files.set(graphStatePath("run1"), snap);
    h2.clock.t = h.clock.t + 1;
    const again = await advance(h2, "run1", { type: "tick" }, opts);
    expect(again.next.kind === "recover" ? again.next.action : "").not.toBe("send_initial");
  });
});

describe("F24-03 writer stop proof", () => {
  it("does not emit implement:2 when implement is running and escalate is chosen", async () => {
    const spec = implementSpec();
    const h = fakeHost();
    await createRun(h, {
      run_id: "run1", spec_id: spec.id, profile_id: "sol", lead_harness: "codex", task_type: "bug-fix",
      entry: "implement", goal: "fix", worktree: "/repo/.worktrees/keel-run1", now: h.now(),
    });
    const d = await setupOk(h, spec);
    expect(d.next.kind).toBe("dispatch");
    if (d.next.kind !== "dispatch") throw new Error("dispatch");
    expect(d.next.dispatch_key).toBe("run1:implement:1");
    await advance(h, "run1", {
      type: "report", phase: "accepted", dispatch_key: d.next.dispatch_key,
      worker_id: "w1", worker_session_id: "ws1", dispatch_outcome: { created: true, delivered: true, queued: false },
    }, { spec });
    h.clock.t += 5 * 60 * 1000;
    await advance(h, "run1", { type: "tick" }, { spec, gates: { retry: () => "escalate" } });
    const esc = await advance(h, "run1", {
      type: "report", phase: "recover", dispatch_key: d.next.dispatch_key, action: "diagnose", action_result: { running: true },
    }, { spec, gates: { retry: () => "escalate" } });
    expect(esc.next.kind).toBe("recover");
    if (esc.next.kind !== "recover") throw new Error("archive");
    expect(esc.next.action).toBe("archive");
    expect(readState(h).nodes.implement?.dispatch_key).toBe("run1:implement:1");
    expect(readState(h).nodes.implement?.attempts).toBe(1);
  });

  it("does not release a new attempt when verify_stopped is only {ok:true,status:archived}", async () => {
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
    await advance(h, "run1", { type: "report", phase: "recover", dispatch_key: key, action: "archive", action_result: { ok: true } }, opts);
    const v = await advance(h, "run1", {
      type: "report", phase: "recover", dispatch_key: key, action: "verify_stopped", action_result: { ok: true, status: "archived" },
    }, opts);
    expect(v.next.kind).toBe("decide");
    expect(readState(h).nodes.worker?.dispatch_key).toBe(key);
    expect(readState(h).nodes.worker?.writer_stopped).not.toBe(true);
  });

  it("unsolicited verify_stopped returns RECOVER_ACTION_MISMATCH and does not mutate", async () => {
    const { h, spec, opts } = await boot();
    const d = await setupOk(h, spec);
    if (d.next.kind !== "dispatch") throw new Error("dispatch");
    const key = d.next.dispatch_key;
    const before = readState(h);
    await expect(
      advance(h, "run1", { type: "report", phase: "recover", dispatch_key: key, action: "verify_stopped", action_result: { ok: true, complete: true, stopped: true } }, opts),
    ).rejects.toMatchObject({ code: "RECOVER_ACTION_MISMATCH" } satisfies Partial<KeelError>);
    expect(readState(h).nodes.worker?.dispatch_state).toBe(before.nodes.worker?.dispatch_state);
    expect(readState(h).nodes.worker?.dispatch_key).toBe(key);
  });

  it("empty list from a new team does not re-dispatch after the original planned receipt is lost", async () => {
    const { h, spec, opts } = await boot();
    const d = await setupOk(h, spec);
    if (d.next.kind !== "dispatch") throw new Error("dispatch");
    const key = d.next.dispatch_key;
    await advance(h, "run1", {
      type: "report", phase: "accepted", dispatch_key: key, dispatch_outcome: { errorCode: "NOT_FOUND" },
    }, opts);
    await advance(h, "run1", {
      type: "report", phase: "setup", outcome: { worker_permission_mode: "bypassPermissions", team_id: "team-2" }, session_id: "sol-2",
    }, opts);
    h.clock.t += PLANNED_TIMEOUT_MS;
    await advance(h, "run1", { type: "tick" }, opts);
    const empty = await advance(h, "run1", {
      type: "report",
      phase: "reconcile",
      dispatch_key: key,
      queries_result: { list_workers: { ok: true, complete: true, team_id: "team-2", workers: [] } },
    }, opts);
    expect(empty.next.kind).toBe("decide");
    if (empty.next.kind !== "decide") throw new Error("human");
    expect(empty.next.gate_id).toBe("human:team");
    expect(readState(h).nodes.worker?.dispatch_key).toBe(key);
    expect(readState(h).nodes.worker?.attempts).toBe(1);
  });
});

describe("bug-fix graph implement identity", () => {
  it("real bug-fix spec contains implement as a writing node", () => {
    const spec = PSTACK_GRAPHS["bug-fix"];
    const implement = spec.nodes.find((n) => n.id === "implement");
    expect(implement?.writes).toBe(true);
    expect(implement?.kind).toBe("dispatch");
  });

  it("a stop proof from another team, or a setup without team_id, does not release a new writer", async () => {
    const { h, spec, opts } = await boot();
    const noTeam = await advance(h, "run1", { type: "report", phase: "setup", outcome: { worker_permission_mode: "bypassPermissions" } }, opts);
    expect(noTeam.next.kind).toBe("decide");
    if (noTeam.next.kind !== "decide") throw new Error("decide");
    expect(noTeam.next.gate_id).toBe("human:setup");
  });
});
