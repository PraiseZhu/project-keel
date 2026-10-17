import { describe, expect, it } from "vitest";
import { makeContext } from "../../src/main/context.ts";
import { runTool } from "../../src/main/dispatch.ts";
import { advance, createRun } from "../../src/main/graph/interpreter.ts";
import { KeelError } from "../../src/main/host.ts";
import { family } from "../../src/shared/fanout.ts";
import { PSTACK_GRAPHS } from "../../src/shared/graph/pstack.ts";
import { fakeHost } from "../helpers/fakeHost.ts";
import { boot, readState, setupOk, usePluginResearch } from "./helpers.ts";

describe("interpreter next kinds", () => {
  usePluginResearch();
  it("emits setup then dispatch with keel-* role and deterministic label", async () => {
    const { h, spec } = await boot();
    const first = await advance(h, "run1", { type: "tick" }, { spec });
    expect(first.next.kind).toBe("setup");
    if (first.next.kind !== "setup") throw new Error("setup");
    expect(first.next.call.args.worker_permission_mode).toBe("bypassPermissions");

    const d = await advance(h, "run1", { type: "report", phase: "setup", outcome: { worker_permission_mode: "bypassPermissions", team_id: "t1" }, session_id: "s1" }, { spec });
    expect(d.next.kind).toBe("dispatch");
    if (d.next.kind !== "dispatch") throw new Error("dispatch");
    expect(d.next.create_worker?.role).toBe("keel-worker");
    expect(d.next.create_worker).toMatchObject({ fast: false, agent_device_id: "local" });
    expect(d.next.create_worker?.label).toMatch(/^keel-[a-z0-9_-]{1,8}-[a-f0-9]{10}$/);
    expect(d.next.create_worker?.label.length).toBeLessThanOrEqual(32);
    expect(JSON.stringify(d.next.create_worker)).not.toMatch(/permission/i);
    expect(d.next.dispatch_key).toBe("run1:worker:1");
    const again = await advance(h, "run1", { type: "tick" }, { spec });
    expect(again.next.kind).toBe("dispatch");
    if (again.next.kind !== "dispatch") throw new Error("dispatch");
    expect(again.next.dispatch_key).toBe("run1:worker:1");
    expect(again.next.create_worker?.label).toBe(d.next.create_worker?.label);
    expect(again.next.create_worker).toMatchObject({ fast: false, agent_device_id: "local" });
  });

  it("accepted delivered → wait; final done walks to wait-ci", async () => {
    const { h, spec } = await boot();
    const d = await setupOk(h, spec);
    if (d.next.kind !== "dispatch") throw new Error("dispatch");
    const acc = await advance(h, "run1", {
      type: "report",
      phase: "accepted",
      dispatch_key: d.next.dispatch_key,
      worker_id: "w1",
      worker_session_id: "ws1",
      dispatch_outcome: { created: true, delivered: true, queued: false },
    }, { spec });
    expect(acc.next.kind).toBe("wait");
    expect(readState(h).author_families).toContain(family("grok-4.6"));
    const fin = await advance(h, "run1", {
      type: "report",
      phase: "final",
      dispatch_key: d.next.dispatch_key,
      inline_report: { status: "done" },
    }, { spec });
    expect(fin.next.kind).toBe("wait");
    expect(readState(h).cursor).toBe("wait-ci");
  });

  it("planned timeout → reconcile; running timebox → recover diagnose", async () => {
    const { h, spec } = await boot();
    const d = await setupOk(h, spec);
    if (d.next.kind !== "dispatch") throw new Error("dispatch");
    h.clock.t += 2 * 60 * 1000;
    const rec = await advance(h, "run1", { type: "tick" }, { spec });
    expect(rec.next.kind).toBe("reconcile");
    if (rec.next.kind !== "reconcile") throw new Error("reconcile");
    expect(rec.next.dispatch_key).toBe(d.next.dispatch_key);

    const { h: h2, spec: s2 } = await boot({ run_id: "run2" });
    const d2 = await setupOk(h2, s2, "run2");
    if (d2.next.kind !== "dispatch") throw new Error("dispatch");
    await advance(h2, "run2", {
      type: "report",
      phase: "accepted",
      dispatch_key: d2.next.dispatch_key,
      worker_id: "w2",
      worker_session_id: "ws2",
      dispatch_outcome: { created: true, delivered: true, queued: false },
    }, { spec: s2 });
    h2.clock.t += 5 * 60 * 1000;
    const recov = await advance(h2, "run2", { type: "tick" }, { spec: s2 });
    expect(recov.next.kind).toBe("recover");
    if (recov.next.kind !== "recover") throw new Error("recover");
    expect(recov.next.action).toBe("diagnose");
    expect(recov.next.call.tool).toBe("worker_status");
  });

  it("gate without hook → decide; human node → decide; WORKER_CANNOT_NEST → stop; reach done", async () => {
    const { h, spec } = await boot();
    const nested = await advance(h, "run1", { type: "tick" }, { spec });
    const stop = await advance(h, "run1", { type: "report", phase: "setup", outcome: { errorCode: "WORKER_CANNOT_NEST" } }, { spec });
    expect(nested.next.kind).toBe("setup");
    expect(stop.next.kind).toBe("stop");
    if (stop.next.kind !== "stop") throw new Error("stop");
    expect(stop.next.reason).toMatch(/worker/);

    const { h: h2, spec: s2 } = await boot({ run_id: "run3" });
    const d = await setupOk(h2, s2, "run3");
    if (d.next.kind !== "dispatch") throw new Error("dispatch");
    await advance(h2, "run3", {
      type: "report",
      phase: "accepted",
      dispatch_key: d.next.dispatch_key,
      worker_id: "w",
      worker_session_id: "ws",
      dispatch_outcome: { created: true, delivered: true, queued: false },
    }, { spec: s2 });
    await advance(h2, "run3", { type: "report", phase: "final", dispatch_key: d.next.dispatch_key, inline_report: { status: "failed" } }, { spec: s2 });
    const dec = await advance(h2, "run3", { type: "tick" }, { spec: s2 });
    expect(dec.next.kind).toBe("recover");
    if (dec.next.kind !== "recover") throw new Error("archive first");
    expect(dec.next.action).toBe("archive");

    const { h: h3, spec: s3 } = await boot({ run_id: "run4" });
    const d3 = await setupOk(h3, s3, "run4");
    if (d3.next.kind !== "dispatch") throw new Error("dispatch");
    await advance(h3, "run4", {
      type: "report", phase: "accepted", dispatch_key: d3.next.dispatch_key,
      worker_id: "w", worker_session_id: "ws", dispatch_outcome: { created: true, delivered: true, queued: false },
    }, { spec: s3 });
    await advance(h3, "run4", { type: "report", phase: "final", dispatch_key: d3.next.dispatch_key, inline_report: { status: "done" } }, { spec: s3 });
    await advance(h3, "run4", { type: "wait_done", on: "ok" }, { spec: s3 });
    const research = await advance(h3, "run4", { type: "tick" }, { spec: s3 });
    expect(research.next.kind).toBe("dispatch");
    if (research.next.kind !== "dispatch") throw new Error("plugin");
    expect(research.next.plugin_task?.phase).toBe("create");
    await advance(h3, "run4", {
      type: "report", phase: "accepted", dispatch_key: research.next.dispatch_key, task_id: "task-1", revision: 1,
    }, { spec: s3 });
    const send = await advance(h3, "run4", { type: "tick" }, { spec: s3 });
    expect(send.next.kind).toBe("dispatch");
    if (send.next.kind !== "dispatch") throw new Error("send");
    expect(send.next.plugin_task?.phase).toBe("send");
    await advance(h3, "run4", {
      type: "report", phase: "accepted", dispatch_key: send.next.dispatch_key, task_run_id: "trun-1",
    }, { spec: s3 });
    const afterResearch = await advance(h3, "run4", { type: "report", phase: "final", dispatch_key: send.next.dispatch_key, inline_report: { status: "done" } }, { spec: s3 });
    const ver = afterResearch.next.kind === "dispatch" ? afterResearch : await advance(h3, "run4", { type: "tick" }, { spec: s3 });
    expect(ver.next.kind).toBe("dispatch");
    if (ver.next.kind !== "dispatch") throw new Error("verify");
    expect(ver.next.create_worker).toBeUndefined();
    expect(ver.next.subagent?.role).toBe("keel-verifier");
    expect(ver.next.subagent?.model).toBe("gpt-6-luna");
    const done = await advance(h3, "run4", {
      type: "report", phase: "final", dispatch_key: ver.next.dispatch_key, inline_report: { status: "done" },
      execution_route: ver.next.subagent?.required_route,
    }, { spec: s3 });
    expect(done.next.kind).toBe("done");
  });

  it("USER_CANCELLED opens a human gate; wrong recover action throws", async () => {
    const { h, spec } = await boot();
    await advance(h, "run1", { type: "tick" }, { spec });
    const cancelled = await advance(h, "run1", { type: "report", phase: "setup", outcome: { errorCode: "USER_CANCELLED" } }, { spec });
    expect(cancelled.next.kind).toBe("decide");
    expect(cancelled.state.status).toBe("waiting_human");

    const { h: h2, spec: s2 } = await boot({ run_id: "runx" });
    const d = await setupOk(h2, s2, "runx");
    if (d.next.kind !== "dispatch") throw new Error("dispatch");
    await advance(h2, "runx", {
      type: "report", phase: "accepted", dispatch_key: d.next.dispatch_key,
      worker_id: "w", worker_session_id: "ws", dispatch_outcome: { created: true, delivered: true, queued: false },
    }, { spec: s2 });
    h2.clock.t += 5 * 60 * 1000;
    await advance(h2, "runx", { type: "tick" }, { spec: s2 });
    await expect(
      advance(h2, "runx", { type: "report", phase: "recover", dispatch_key: d.next.dispatch_key, action: "send_initial" }, { spec: s2 }),
    ).rejects.toMatchObject({ code: "RECOVER_ACTION_MISMATCH" } satisfies Partial<KeelError>);
  });

  it("verifier skips author families and stops when none remain", async () => {
    expect(family("gpt-6-luna")).toBe("gpt");
    const { h, spec } = await boot({ entry: "verify", author_families: ["gpt", "grok"] });
    const first = await advance(h, "run1", { type: "tick" }, { spec });
    expect(first.next.kind).toBe("stop");
    if (first.next.kind !== "stop") throw new Error("stop");
    expect(first.next.reason).toMatch(/不同族/);
  });
});

const emptyCtx = { lanes: [], routingPath: null, boardRepos: [], plansDir: null };
const plannedWorker = { agent: "pi", model: "grok-4.6", provider_id: "art-cindy", effort: "high" };

describe("planned worker replay and accepted resolved route", () => {
  it("re-tick before accepted keeps the same key and fast:false / local", async () => {
    const { h, spec } = await boot({ run_id: "run-replay" });
    const d = await setupOk(h, spec, "run-replay");
    if (d.next.kind !== "dispatch") throw new Error("dispatch");
    expect(d.next.create_worker).toMatchObject({ ...plannedWorker, fast: false, agent_device_id: "local" });
    const again = await advance(h, "run-replay", { type: "tick" }, { spec });
    expect(again.next.kind).toBe("dispatch");
    if (again.next.kind !== "dispatch") throw new Error("dispatch");
    expect(again.next.dispatch_key).toBe(d.next.dispatch_key);
    expect(again.next.create_worker).toMatchObject({ ...plannedWorker, fast: false, agent_device_id: "local" });
    expect(again.next.create_worker?.fast).not.toBe(true);
    expect(again.next.create_worker?.agent_device_id).not.toBeUndefined();
  });

  async function bootWriter(runId: string) {
    const spec = PSTACK_GRAPHS["bug-fix"];
    const h = fakeHost({
      node: (method: string) => {
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "feat/x", head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } };
        if (method === "git/changed-files") return { ok: true, result: { files: [] } };
        return { ok: false, message: method };
      },
    });
    await createRun(h, {
      run_id: runId,
      spec_id: spec.id,
      profile_id: "sol",
      lead_harness: "codex",
      task_type: "bug-fix",
      entry: "implement",
      goal: "fix the bug",
      worktree: "/repo/.worktrees/keel-run1",
      scopeAllow: ["src/**"],
      now: h.now(),
    });
    const d = await advance(h, runId, {
      type: "report", phase: "setup",
      outcome: { worker_permission_mode: "bypassPermissions", team_id: "t1" },
      session_id: "s1",
    }, { spec });
    return { h, spec, d };
  }

  it("accepted resolved that differs in model, provider, or effort is EXECUTION_ROUTE_MISMATCH", async () => {
    const mismatches = [
      { id: "run-mis-model", resolved: { ...plannedWorker, model: "gpt-6-luna" } },
      { id: "run-mis-provider", resolved: { ...plannedWorker, provider_id: "xd", providerId: "xd" } },
      { id: "run-mis-effort", resolved: { ...plannedWorker, effort: "low" } },
    ];
    for (const { id: runId, resolved } of mismatches) {
      const { h, d } = await bootWriter(runId);
      if (d.next.kind !== "dispatch") throw new Error("dispatch");
      expect(d.next.create_worker).toMatchObject(plannedWorker);
      const out: any = await runTool(makeContext(h, "acc-mis", emptyCtx), "keel_report", {
        run_id: runId,
        phase: "accepted",
        dispatch_key: d.next.dispatch_key,
        worker_id: "w1",
        worker_session_id: "ws1",
        dispatch_outcome: { dispatched: true, wakeKind: "immediate" },
        resolved,
      });
      expect(out.ok, JSON.stringify({ resolved, out })).toBe(false);
      expect(out.errorCode).toBe("EXECUTION_ROUTE_MISMATCH");
    }
  });

  it("accepted resolved that matches planned model/provider/effort proceeds", async () => {
    const { h, d } = await bootWriter("run-ok-resolved");
    if (d.next.kind !== "dispatch") throw new Error("dispatch");
    const out: any = await runTool(makeContext(h, "acc-ok", emptyCtx), "keel_report", {
      run_id: "run-ok-resolved",
      phase: "accepted",
      dispatch_key: d.next.dispatch_key,
      worker_id: "w1",
      worker_session_id: "ws1",
      dispatch_outcome: { dispatched: true, wakeKind: "immediate" },
      resolved: { agent: "pi", model: "grok-4.6", providerId: "art-cindy", effort: "high" },
    });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(out.result.next.kind).toBe("wait");
    expect(readState(h, "run-ok-resolved").nodes.implement?.actual_route).toEqual(plannedWorker);
  });
});
