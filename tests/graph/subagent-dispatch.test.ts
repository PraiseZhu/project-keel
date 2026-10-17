import { afterEach, describe, expect, it } from "vitest";
import { makeContext } from "../../src/main/context.ts";
import { runTool } from "../../src/main/dispatch.ts";
import { asNudgeRun } from "../../src/main/host-bridge.ts";
import { advance, createRun, type AdvanceOpts } from "../../src/main/graph/interpreter.ts";
import { shouldNudge } from "../../src/main/graph/nudge.ts";
import { ACCEPTED_TIMEOUT_MS, PLANNED_TIMEOUT_MS, type GraphRunState, type Next } from "../../src/main/graph/state.ts";
import { cloneManual, DEFAULT_MANUAL, type ModelManual, type Route } from "../../src/shared/manual/schema.ts";
import { PSTACK_GRAPHS } from "../../src/shared/graph/pstack.ts";
import type { GraphSpec } from "../../src/shared/graph/spec.ts";
import { graphStatePath } from "../../src/main/store/runs.ts";
import {
  cleanupRepos,
  leadLoop,
  makeE2eHost,
  makeWorld,
  nativeFinalArgs,
  SC,
  startRun,
} from "../e2e/helpers.ts";
import { fakeHost, type FakeHost } from "../helpers/fakeHost.ts";

const HEAD = "a".repeat(40);

function claudeXdManual(): ModelManual {
  const manual = cloneManual(DEFAULT_MANUAL);
  const grok = manual.profiles.find((p) => p.id === "grok")!;
  (grok as { lead: Route }).lead = { agent: "claude-code", model: "anthropic/claude-opus-5-5", provider_id: "xd", effort: "high" };
  return manual;
}

function miniExploreSpec(): GraphSpec {
  return {
    id: "bug-fix",
    version: 1,
    entry: "explore",
    exits: ["done", "stopped"],
    covers: ["bug-fix"],
    adaptations: [],
    nodes: [
      { id: "explore", kind: "dispatch", role: "explorer", writes: false, playbook_steps: [], timebox_min: 20, max_attempts: 3 },
      { id: "worker", kind: "dispatch", role: "worker", writes: true, playbook_steps: [], timebox_min: 5, max_attempts: 3 },
      { id: "verify", kind: "dispatch", role: "verifier", writes: false, playbook_steps: [], timebox_min: 5, max_attempts: 2 },
      { id: "done", kind: "tool", writes: false, playbook_steps: [], timebox_min: 1, max_attempts: 1 },
      { id: "stopped", kind: "tool", writes: false, playbook_steps: [], timebox_min: 1, max_attempts: 1 },
    ],
    edges: [
      { from: "explore", to: "worker", on: "ok" },
      { from: "explore", to: "stopped", on: "fail" },
      { from: "worker", to: "verify", on: "ok" },
      { from: "worker", to: "stopped", on: "fail" },
      { from: "verify", to: "done", on: "ok" },
      { from: "verify", to: "stopped", on: "fail" },
    ],
  };
}

function cfg(manual: ModelManual): AdvanceOpts["config"] {
  return { manual, lanes: [], limits: { concurrentRuns: 4, inFlightNodesPerRun: 3, astraBudget: 4 }, thresholds: { act: 0.75, strict: 0.8 } };
}

async function bootExplore(over: {
  run_id?: string;
  profile_id?: string;
  lead_harness?: "codex" | "claude-code" | "pi";
  manual?: ModelManual;
  spec?: GraphSpec;
  worktree?: string;
} = {}): Promise<{ h: FakeHost; spec: GraphSpec; opts: AdvanceOpts; runId: string }> {
  const spec = over.spec ?? miniExploreSpec();
  const manual = over.manual ?? DEFAULT_MANUAL;
  const h = fakeHost({
    kv: { manual },
    node: (method: string) => {
      if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "feat/x", head: HEAD } };
      if (method === "git/changed-files") return { ok: true, result: { files: [] } };
      return { ok: false, message: method };
    },
  });
  const runId = over.run_id ?? "run-sa";
  await createRun(h, {
    run_id: runId,
    spec_id: spec.id,
    profile_id: over.profile_id ?? "grok",
    lead_harness: over.lead_harness ?? "claude-code",
    task_type: spec.id === "investigation" ? "investigation" : "bug-fix",
    entry: spec.entry,
    goal: "fix the bug",
    worktree: over.worktree ?? "/repo/.worktrees/keel-run-sa",
    scopeAllow: ["src/**"],
    now: h.now(),
  });
  return { h, spec, opts: { spec, config: cfg(manual) }, runId };
}

function asDispatch(next: Next): Extract<Next, { kind: "dispatch" }> {
  if (next.kind !== "dispatch") throw new Error(`expected dispatch, got ${next.kind}`);
  return next;
}

describe("SC-1 subagent vs orca dispatch", () => {
  it("claude-code same-harness read-only explore returns subagent, not create_worker", async () => {
    const { h, opts, runId } = await bootExplore({ manual: claudeXdManual() });
    const out = await advance(h, runId, { type: "tick" }, opts);
    const d = asDispatch(out.next);
    expect(d.create_worker).toBeUndefined();
    expect(d.subagent).toMatchObject({
      harness: "claude-code",
      model: "anthropic/claude-haiku-5-5",
      effort: "medium",
      role: "keel-explorer",
      require_exact_route: true,
    });
    expect(d.subagent?.route).toEqual({ model: "anthropic/claude-haiku-5-5", provider_id: "xd" });
    expect(d.subagent?.required_route).toEqual({
      agent: "claude-code", model: "anthropic/claude-haiku-5-5", provider_id: "xd", effort: "medium",
    });
    expect(d.note).toMatch(/NATIVE_ROUTE_UNSUPPORTED/);
    expect(d.note).toMatch(/失败后也不自动转 Worker/);
    expect(d.subagent?.report_path).toMatch(/\.keel\/explore-1\.md$/);
    expect(d.after).toBe("keel_report phase=final");
    expect(out.state.nodes.explore.dispatch_state).toBe("running");
    expect(out.state.nodes.explore.planned_params?.channel).toBe("subagent");
    expect(out.state.nodes.explore.team_id).toBeUndefined();
    expect(out.state.team?.ready).not.toBe(true);
  });

  it("claude-code sonnet explorer also returns subagent", async () => {
    const manual = cloneManual(DEFAULT_MANUAL);
    const grok = manual.profiles.find((p) => p.id === "grok")!;
    (grok.nodes.default as { explorer: { primary: Route } }).explorer = { primary: { agent: "claude-code", model: "anthropic/claude-sonnet-5-5", provider_id: "xd", effort: "medium" } };
    const { h, opts, runId } = await bootExplore({ run_id: "run-sonnet", manual });
    const d = asDispatch((await advance(h, runId, { type: "tick" }, opts)).next);
    expect(d.subagent).toMatchObject({ harness: "claude-code", model: "anthropic/claude-sonnet-5-5", effort: "medium" });
    expect(d.create_worker).toBeUndefined();
  });

  it("default sol + codex explore dispatches the exact explorer route and stays native after failure", async () => {
    const { h, opts, runId } = await bootExplore({ profile_id: "sol", lead_harness: "codex", manual: DEFAULT_MANUAL });
    const out = await advance(h, runId, { type: "tick" }, opts);
    const first = asDispatch(out.next);
    expect(first.create_worker).toBeUndefined();
    expect(first.subagent?.harness).toBe("codex");
    expect(first.subagent?.model).toBe("gpt-6-luna");
    expect(first.subagent?.effort).toBe("medium");
    expect(first.subagent?.route).toEqual({ model: "gpt-6-luna", provider_id: "art-cindy" });
    expect(first.subagent?.required_route).toEqual({
      agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy", effort: "medium",
    });
    expect(first.note).toMatch(/失败后也不自动转 Worker/);
    expect(out.state.nodes.explore.actual_route).toBeUndefined();
    expect(out.state.team?.ready).not.toBe(true);

    const failed = await advance(h, runId, { type: "report", phase: "final", dispatch_key: first.dispatch_key, inline_report: { status: "failed" }, report: { status: "failed", summary: "subagent 不可用" } }, opts);
    const retry = asDispatch(failed.next);
    expect(retry.dispatch_key).toBe(`${runId}:explore:2`);
    expect(retry.create_worker).toBeUndefined();
    expect(retry.subagent).toMatchObject({ harness: "codex", model: "gpt-6-luna", effort: "medium" });
  });

  it("claude-code same-harness explorer keeps the exact model instead of swapping to the lead", async () => {
    const routes: Route[] = [
      { agent: "claude-code", model: "grok-4.6", provider_id: "art-cindy", effort: "medium" },
      { agent: "claude-code", model: "anthropic/claude-opus-5-5", provider_id: "xd", effort: "medium" },
    ];
    for (const route of routes) {
      const manual = cloneManual(DEFAULT_MANUAL);
      const grok = manual.profiles.find((p) => p.id === "grok")!;
      (grok.nodes.default as { explorer: { primary: Route } }).explorer = { primary: route };
      const { h, opts, runId } = await bootExplore({ run_id: `run-${route.model.split("/").pop()!.replace(/\./g, "-")}`, manual });
      const d = asDispatch((await advance(h, runId, { type: "tick" }, opts)).next);
      expect(d.create_worker, route.model).toBeUndefined();
      expect(d.subagent, route.model).toMatchObject({ harness: "claude-code", model: route.model, effort: "medium" });
      expect(d.subagent?.required_route, route.model).toEqual(route);
    }
  });

  it("pi lead does not silently open a Worker for a codex explorer route", async () => {
    const { h, opts, runId } = await bootExplore({ profile_id: "sol", lead_harness: "pi", manual: DEFAULT_MANUAL });
    const out = await advance(h, runId, { type: "tick" }, opts);
    expect(out.next.kind).toBe("decide");
    if (out.next.kind !== "decide") throw new Error("decide");
    expect(out.next.gate_id).toBe("human:explore");
    expect(out.next.question).toMatch(/NATIVE_ROUTE_UNSUPPORTED/);
    expect(out.next.options).toEqual(["retry", "stop"]);
  });

  it("write and verifier nodes stay on create_worker under the same claude-code profile", async () => {
    const { h, opts, runId } = await bootExplore({ manual: claudeXdManual() });
    const explore = asDispatch((await advance(h, runId, { type: "tick" }, opts)).next);
    const afterExplore = await advance(h, runId, { type: "report", phase: "final", dispatch_key: explore.dispatch_key, inline_report: { status: "done" }, report: { status: "done", files_changed: [], functions_touched: ["one"] } }, opts);
    expect(afterExplore.next.kind).toBe("setup");
    const worker = asDispatch((await advance(h, runId, { type: "report", phase: "setup", outcome: { worker_permission_mode: "bypassPermissions", team_id: "t1" }, session_id: "s1" }, opts)).next);
    expect(worker.create_worker?.role).toBe("keel-worker");
    expect(worker.create_worker).toMatchObject({ fast: false, agent_device_id: "local" });
    expect(worker.subagent).toBeUndefined();
    await advance(h, runId, { type: "report", phase: "accepted", dispatch_key: worker.dispatch_key, worker_id: "w", worker_session_id: "ws", dispatch_outcome: { created: true, delivered: true, queued: false } }, opts);
    const afterWorker = await advance(h, runId, { type: "report", phase: "final", dispatch_key: worker.dispatch_key, inline_report: { status: "done" }, report: { status: "done", files_changed: ["src/a.ts"], functions_touched: ["one"] } }, opts);
    expect(afterWorker.next.kind).toBe("decide");
    if (afterWorker.next.kind !== "decide") throw new Error("decide");
    expect(afterWorker.next.gate_id).toBe("human:verify");
    expect(afterWorker.next.question).toMatch(/NATIVE_ROUTE_UNSUPPORTED/);
  });

  it("feature architect-plan is a one-shot native sub with the exact architect model", async () => {
    const spec = PSTACK_GRAPHS.feature;
    const manual = claudeXdManual();
    const h = fakeHost({
      kv: { manual },
      node: (method: string) => {
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "feat/x", head: HEAD } };
        if (method === "git/changed-files") return { ok: true, result: { files: [] } };
        return { ok: false, message: method };
      },
    });
    const runId = "run-ap";
    await createRun(h, {
      run_id: runId,
      spec_id: spec.id,
      profile_id: "grok",
      lead_harness: "claude-code",
      task_type: "feature",
      entry: "architect-plan",
      goal: "新增支付功能",
      worktree: "/repo/.worktrees/keel-run-ap",
      astra_budget: 4,
      now: h.now(),
    });
    const opts = { spec, config: cfg(manual) };
    const d = asDispatch((await advance(h, runId, { type: "tick" }, opts)).next);
    expect(d.dispatch_key).toContain(":architect-plan:");
    expect(d.create_worker).toBeUndefined();
    expect(d.subagent).toMatchObject({
      harness: "claude-code",
      role: "keel-architect",
      model: "anthropic/claude-opus-5-5",
    });
  });

  it("codex lead with explorer equal to lead model still sends the exact model id", async () => {
    const manual = cloneManual(DEFAULT_MANUAL);
    const sol = manual.profiles.find((p) => p.id === "sol")!;
    (sol.nodes.default as { explorer: { primary: Route } }).explorer = { primary: { agent: "codex", model: "gpt-6.1-sol", provider_id: "art-cindy", effort: "medium" } };
    const { h, opts, runId } = await bootExplore({ profile_id: "sol", lead_harness: "codex", manual });
    const d = asDispatch((await advance(h, runId, { type: "tick" }, opts)).next);
    expect(d.subagent).toMatchObject({ harness: "codex", model: "gpt-6.1-sol", effort: "medium" });
    expect(d.create_worker).toBeUndefined();
  });
});

describe("SC-2 subagent in-flight and retry", () => {
  it("in-flight wait does not reconcile; accepted throws; final advances", async () => {
    const { h, opts, runId } = await bootExplore({ manual: claudeXdManual() });
    const d = asDispatch((await advance(h, runId, { type: "tick" }, opts)).next);
    h.clock.t += PLANNED_TIMEOUT_MS + ACCEPTED_TIMEOUT_MS;
    const waited = await advance(h, runId, { type: "tick" }, opts);
    expect(waited.next.kind).toBe("wait");
    if (waited.next.kind !== "wait") throw new Error("wait");
    expect(waited.next.note).toMatch(/subagent 在途/);
    expect(JSON.stringify(waited.next)).not.toMatch(/list_workers|reconcile/);
    await expect(advance(h, runId, { type: "report", phase: "accepted", dispatch_key: d.dispatch_key, worker_id: "w", worker_session_id: "ws", dispatch_outcome: { created: true, delivered: true } }, opts)).rejects.toMatchObject({ code: "REPORT_INVALID" });
    const fin = await advance(h, runId, { type: "report", phase: "final", dispatch_key: d.dispatch_key, inline_report: { status: "done" }, report: { status: "done", files_changed: [], functions_touched: ["one"] } }, opts);
    expect(fin.state.nodes.explore.status).toBe("succeeded");
    expect(fin.state.nodes.explore.attempts).toBe(1);
    expect(fin.state.author_families).toEqual([]);
    expect(fin.next.kind).toBe("setup");
    const worker = asDispatch((await advance(h, runId, { type: "report", phase: "setup", outcome: { worker_permission_mode: "bypassPermissions", team_id: "t1" } }, opts)).next);
    expect(worker.create_worker).toBeTruthy();
  });

  it("timebox opens human gate; late final clears it; retry attempt 2 stays native", async () => {
    const { h, opts, runId } = await bootExplore({ manual: claudeXdManual() });
    const d = asDispatch((await advance(h, runId, { type: "tick" }, opts)).next);
    h.clock.t += 20 * 60 * 1000;
    const timed = await advance(h, runId, { type: "tick" }, opts);
    expect(timed.next.kind).toBe("decide");
    if (timed.next.kind !== "decide") throw new Error("decide");
    expect(timed.next.gate_id).toBe("human:explore");
    expect(timed.next.options).toEqual(["retry", "stop"]);
    const late = await advance(h, runId, { type: "report", phase: "final", dispatch_key: d.dispatch_key, inline_report: { status: "done" }, report: { status: "done", files_changed: [], functions_touched: ["one"] } }, opts);
    expect(late.state.nodes.explore.status).toBe("succeeded");
    expect(late.next.kind).not.toBe("decide");

    // keel_gate loads the real spec by spec_id; explore lives only in the investigation graph.
    const { h: h2, opts: o2, runId: r2 } = await bootExplore({ run_id: "run-retry", manual: claudeXdManual(), spec: PSTACK_GRAPHS.investigation });
    asDispatch((await advance(h2, r2, { type: "tick" }, o2)).next);
    h2.clock.t += 20 * 60 * 1000;
    await advance(h2, r2, { type: "tick" }, o2);
    const afterRetry: any = await runTool(makeContext(h2, "c-retry", { lanes: [], routingPath: null, boardRepos: [], plansDir: null }), "keel_gate", {
      run_id: r2, gate_id: "human:explore", answer: "retry",
    });
    expect(afterRetry.ok, afterRetry.message).toBe(true);
    const attempt2 = asDispatch(afterRetry.result.next);
    expect(attempt2.dispatch_key).toBe("run-retry:explore:2");
    expect(attempt2.create_worker).toBeUndefined();
    expect(attempt2.subagent).toMatchObject({ harness: "claude-code", model: "anthropic/claude-haiku-5-5" });
  });

  it("keel_wait on a subagent in-flight node returns wait, not reconcile", async () => {
    const { h, opts, runId } = await bootExplore({ manual: claudeXdManual() });
    await advance(h, runId, { type: "tick" }, opts);
    const waited: any = await runTool(makeContext(h, "c1", { lanes: [], routingPath: null, boardRepos: [], plansDir: null }), "keel_wait", { run_id: runId });
    expect(waited.ok).toBe(true);
    expect(waited.result.next.kind).toBe("wait");
    expect(JSON.stringify(waited.result)).not.toMatch(/reconcile|list_workers/);
  });
});

describe("R43-01 subagent timeout retry must not inherit started_at", () => {
  it("native retry after subagent timeout starts its own timebox", async () => {
    const { h, opts, runId } = await bootExplore({ run_id: "r-timeout-queue", manual: claudeXdManual(), spec: PSTACK_GRAPHS.investigation });
    const t0 = h.now();
    asDispatch((await advance(h, runId, { type: "tick" }, opts)).next);
    h.clock.t += 20 * 60 * 1000;
    const timed = await advance(h, runId, { type: "tick" }, opts);
    expect(timed.next.kind).toBe("decide");
    const afterRetry: any = await runTool(makeContext(h, "c-r43-01", { lanes: [], routingPath: null, boardRepos: [], plansDir: null }), "keel_gate", {
      run_id: runId, gate_id: "human:explore", answer: "retry",
    });
    expect(afterRetry.ok, afterRetry.message).toBe(true);
    const attempt2 = asDispatch(afterRetry.result.next);
    expect(attempt2.dispatch_key).toBe("r-timeout-queue:explore:2");
    expect(attempt2.subagent).toBeTruthy();
    expect(attempt2.create_worker).toBeUndefined();
    const st = JSON.parse(h.files.get(graphStatePath(runId))!) as GraphRunState;
    expect(st.nodes.explore.started_at).toBe(h.now());
    expect(st.nodes.explore.started_at).not.toBe(t0);
    const waited = await advance(h, runId, { type: "tick" }, opts);
    expect(waited.next.kind).toBe("wait");
    expect(waited.state.nodes.explore.dispatch_state).toBe("running");
    expect(waited.state.nodes.explore.started_at).not.toBe(t0);
    expect(JSON.stringify(waited.next)).not.toMatch(/list_workers|reconcile/);
  });
});

describe("R43-02 leftover plugin_task must not hijack a new Orca research attempt", () => {
  it("returning to research after a completed plugin research clears task before create_worker", async () => {
    // Change graphs no longer have read-only research; loop the investigation graph back to explore so research runs twice.
    const spec = structuredClone(PSTACK_GRAPHS.investigation);
    spec.edges = spec.edges.map((e) => (e.from === "research" && e.on === "ok" ? { ...e, to: "explore" } : e));
    const researchNode = spec.nodes.find((n) => n.id === "research");
    if (!researchNode) throw new Error("research");
    researchNode.kind = "plugin_task";
    const h = fakeHost({
      kv: { manual: DEFAULT_MANUAL },
      node: (method: string) => {
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "feat/x", head: HEAD } };
        if (method === "git/changed-files") return { ok: true, result: { files: [] } };
        return { ok: false, message: method };
      },
    });
    const runId = "r-legacy-research-loop";
    await createRun(h, {
      run_id: runId,
      spec_id: "investigation",
      profile_id: "sol",
      lead_harness: "codex",
      task_type: "investigation",
      entry: "research",
      goal: "fix the bug",
      worktree: "/repo/.worktrees/keel-run-sa",
      scopeAllow: ["src/**"],
      now: h.now(),
    });
    const opts: AdvanceOpts = {
      spec,
      config: cfg(DEFAULT_MANUAL),
    };
    const create = asDispatch((await advance(h, runId, { type: "tick" }, opts)).next);
    expect(create.plugin_task?.phase).toBe("create");
    const send = asDispatch((await advance(h, runId, {
      type: "report", phase: "accepted", dispatch_key: create.dispatch_key, task_id: "old-task", revision: 1,
    }, opts)).next);
    expect(send.plugin_task?.phase).toBe("send");
    await advance(h, runId, {
      type: "report", phase: "accepted", dispatch_key: send.dispatch_key, task_run_id: "old-task-run",
    }, opts);
    const afterResearch = await advance(h, runId, {
      type: "report", phase: "final", dispatch_key: send.dispatch_key,
      inline_report: { status: "done" }, report: { status: "done", files_changed: [], functions_touched: ["one"] },
    }, opts);
    expect(afterResearch.state.cursor).toBe("explore");
    researchNode.kind = "dispatch";
    const explore = asDispatch(afterResearch.next);
    expect(explore.subagent).toBeTruthy();
    const afterExplore = await advance(h, runId, {
      type: "report", phase: "final", dispatch_key: explore.dispatch_key,
      inline_report: { status: "done" }, report: { status: "done", files_changed: [], functions_touched: ["one"] },
    }, opts);
    const research2 = asDispatch(afterExplore.next);
    expect(research2.dispatch_key).toBe(`${runId}:research:2`);
    expect(research2.create_worker).toBeUndefined();
    expect(research2.plugin_task).toBeUndefined();
    expect(research2.subagent).toMatchObject({ harness: "codex", model: "gpt-6-luna" });
    expect(research2.subagent?.task).not.toMatch(/不要写 \.keel\/ 文件，也不要调用 keel_report/);
    expect(research2.subagent?.task).toMatch(/主控会把它原样交给 KEEL/);
    const st = JSON.parse(h.files.get(graphStatePath(runId))!) as GraphRunState;
    expect(st.nodes.research?.task).toBeUndefined();
    const acc2: any = await runTool(makeContext(h, "c-r43-02", { lanes: [], routingPath: null, boardRepos: [], plansDir: null }), "keel_report", {
      run_id: runId,
      phase: "accepted",
      dispatch_key: research2.dispatch_key,
      worker_id: "w-research-2",
      worker_session_id: "s-research-2",
      dispatch_outcome: { created: true, delivered: true, queued: false },
    });
    expect(acc2.ok).toBe(false);
    expect(acc2.errorCode).toBe("REPORT_INVALID");
    expect(JSON.stringify(research2)).not.toMatch(/getRun|old-task-run|old-task/);
    expect(st.nodes.research?.dispatch_state).toBe("running");
  });
});

describe("SC-2 failed subagent stays native", () => {
  it("failed final on attempt 1 then retry is still a native subagent", async () => {
    const spec: GraphSpec = {
      ...miniExploreSpec(),
      edges: [
        { from: "explore", to: "explore", on: "fail" },
        { from: "explore", to: "worker", on: "ok" },
        { from: "worker", to: "verify", on: "ok" },
        { from: "worker", to: "stopped", on: "fail" },
        { from: "verify", to: "done", on: "ok" },
        { from: "verify", to: "stopped", on: "fail" },
      ],
    };
    const { h, opts, runId } = await bootExplore({ manual: claudeXdManual(), spec });
    const d = asDispatch((await advance(h, runId, { type: "tick" }, opts)).next);
    const failed = await advance(h, runId, { type: "report", phase: "final", dispatch_key: d.dispatch_key, inline_report: { status: "failed" }, report: { status: "failed" } }, opts);
    expect(failed.state.cursor).toBe("explore");
    const attempt2 = asDispatch(failed.next);
    expect(attempt2.dispatch_key).toBe(`${runId}:explore:2`);
    expect(attempt2.create_worker).toBeUndefined();
    expect(attempt2.subagent).toBeTruthy();
    expect(failed.state.nodes.explore.status).toBe("active");
  });

  it("subagent explore failed final retries native instead of walking fail to stop", async () => {
    const { h, opts, runId } = await bootExplore({ manual: claudeXdManual() });
    const d = asDispatch((await advance(h, runId, { type: "tick" }, opts)).next);
    expect(d.subagent).toBeTruthy();
    expect(d.create_worker).toBeUndefined();
    const failed = await advance(h, runId, {
      type: "report",
      phase: "final",
      dispatch_key: d.dispatch_key,
      inline_report: { status: "failed" },
      report: { status: "failed" },
    }, opts);
    expect(failed.next.kind, `unexpected ${failed.next.kind}`).not.toBe("stop");
    expect(failed.state.cursor).toBe("explore");
    expect(failed.state.nodes.explore.attempts).toBe(2);
    const attempt2 = asDispatch(failed.next);
    expect(attempt2.dispatch_key).toBe(`${runId}:explore:2`);
    expect(attempt2.create_worker).toBeUndefined();
    expect(attempt2.subagent).toBeTruthy();
  });
});

describe("nudge maps subagent dispatch to wait", () => {
  it("does not nudge while subagent is inside timebox", () => {
    const t0 = Date.UTC(2026, 9, 10, 12, 0, 0);
    const raw = {
      run_id: "r",
      status: "running",
      updated_at: t0,
      next: { kind: "dispatch", subagent: { harness: "claude-code", model: "anthropic/claude-haiku-5-5" } },
      nodes: { explore: { dispatch_state: "running", started_at: t0 } },
      spec_id: "investigation",
    };
    const mapped = asNudgeRun(raw)!;
    expect(mapped.next?.kind).toBe("wait");
    expect(shouldNudge(mapped, t0 + 1000, { turn: { endReason: "completed" } }).nudge).toBe(false);
  });

  it("nudges after timebox", () => {
    const t0 = Date.UTC(2026, 9, 10, 12, 0, 0);
    const raw = {
      run_id: "r",
      status: "running",
      updated_at: t0,
      next: { kind: "dispatch", subagent: { harness: "claude-code", model: "anthropic/claude-haiku-5-5" } },
      nodes: { explore: { dispatch_state: "running", started_at: t0 } },
      spec_id: "investigation",
    };
    const mapped = asNudgeRun(raw)!;
    expect(shouldNudge(mapped, t0 + 21 * 60_000, { turn: { endReason: "completed" } }).nudge).toBe(true);
  });
});

describe("SC-3 research is dispatch", () => {
  afterEach(cleanupRepos);

  // Change graphs no longer have a research node; only the investigation graph does.
  it("investigation research is the lead's subagent for default sol, never plugin_task or human:reconcile", async () => {
    const world = makeWorld();
    const host = makeE2eHost(world);
    const started = await startRun(host, {
      goal: "调查登录报错", repo_dir: world.repoDir, lead: "codex", playbook: "investigation", sc: [...SC],
    });
    const run = await leadLoop(host, started, world, { stopWhen: (_n, state) => state.cursor === "report" });
    const research = run.steps.find((s) => s.kind === "dispatch" && s.dispatch_key?.includes(":research:"));
    expect(research, `steps=${JSON.stringify(run.steps.map((s) => s.kind))}`).toBeTruthy();
    if (research?.kind !== "dispatch") throw new Error("research");
    expect(research.plugin_task).toBeUndefined();
    expect(research.create_worker).toBeUndefined();
    expect(research.subagent?.harness).toBe("codex");
    expect(research.subagent?.model).toBe("gpt-6-luna");
    expect(run.steps.some((s) => s.kind === "decide" && s.gate_id === "human:reconcile")).toBe(false);
    expect(run.state.cursor).toBe("report");
  });

  it("claude-code xd research is subagent", async () => {
    const world = makeWorld();
    const host = makeE2eHost(world);
    host.kv.manual = claudeXdManual();
    const started = await startRun(host, {
      goal: "调查登录报错", repo_dir: world.repoDir, lead: "claude-code", profile: "grok", playbook: "investigation", sc: [...SC],
    });
    const run = await leadLoop(host, started, world, { stopWhen: (_n, state) => state.cursor === "report" });
    const research = run.steps.find((s) => s.kind === "dispatch" && s.dispatch_key?.includes(":research:"));
    expect(research).toBeTruthy();
    if (research?.kind !== "dispatch") throw new Error("research");
    expect(research.plugin_task).toBeUndefined();
    expect(research.subagent?.harness).toBe("claude-code");
    expect(research.subagent?.model).toBe("anthropic/claude-haiku-5-5");
  });
});

describe("accepted error copy", () => {
  it("mentions subagent must not report accepted", async () => {
    // keel_report loads the real spec by spec_id; explore lives only in the investigation graph.
    const { h, opts, runId } = await bootExplore({ manual: claudeXdManual(), spec: PSTACK_GRAPHS.investigation });
    const d = asDispatch((await advance(h, runId, { type: "tick" }, opts)).next);
    await expect(
      runTool(makeContext(h, "c-acc", { lanes: [], routingPath: null, boardRepos: [], plansDir: null }), "keel_report", {
        run_id: runId,
        phase: "accepted",
        dispatch_key: d.dispatch_key,
        worker_id: "w",
        worker_session_id: "ws",
        dispatch_outcome: { dispatched: true, wakeKind: "immediate" },
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: "REPORT_INVALID" });
  });
});

const emptyCtx = { lanes: [], routingPath: null, boardRepos: [], plansDir: null };

function doneReport(key: string) {
  return {
    status: "done" as const,
    summary: "ok",
    files_changed: [] as string[],
    functions_touched: ["one"],
    ran: [] as { cmd: string; exit_code: number }[],
    dispatch_key: key,
  };
}

describe("exact route, hidden, effort, provider", () => {
  it("cannot turn an unsupported native route into success with an unoffered gate answer", async () => {
    const manual = cloneManual(DEFAULT_MANUAL);
    const grok = manual.profiles.find((profile) => profile.id === "grok")!;
    (grok.nodes.default as { explorer: { primary: Route } }).explorer = {
      primary: { agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy", effort: "medium" },
    };
    const { h, opts, runId } = await bootExplore({ run_id: "run-gate-route-guard", manual, spec: PSTACK_GRAPHS.investigation });
    const pending = await advance(h, runId, { type: "tick" }, opts);
    expect(pending.next).toMatchObject({ kind: "decide", gate_id: "human:explore", options: ["retry", "stop"] });
    const context = makeContext(h, "gate-route-guard", emptyCtx);
    const before = h.files.get(graphStatePath(runId));
    for (const answer of ["ok", "fail", "adopt"]) {
      const rejected = await runTool(context, "keel_gate", { run_id: runId, gate_id: "human:explore", answer });
      expect(rejected).toMatchObject({ ok: false, errorCode: "INVALID_GATE_ANSWER" });
      expect(h.files.get(graphStatePath(runId))).toBe(before);
    }
    const stale = await runTool(context, "keel_gate", { run_id: runId, gate_id: "human:research", answer: "retry" });
    expect(stale).toMatchObject({ ok: false, errorCode: "GATE_NOT_PENDING" });
    expect(h.files.get(graphStatePath(runId))).toBe(before);
    const queued = JSON.parse(before!) as GraphRunState;
    queued.sol_decisions.push({ gate_id: "human:explore", answer: "ok", attempt: 0 });
    h.files.set(graphStatePath(runId), JSON.stringify(queued));
    const guarded = await advance(h, runId, { type: "tick" }, opts);
    expect(guarded.next).toMatchObject({ kind: "decide", gate_id: "human:explore" });
    expect(guarded.state.nodes.explore?.status).not.toBe("succeeded");
    expect(guarded.state.sol_decisions).toEqual([]);
    const retry = await runTool(context, "keel_gate", { run_id: runId, gate_id: "human:explore", answer: "retry" });
    expect(retry).toMatchObject({ ok: true, result: { next: { kind: "decide", gate_id: "human:explore" } } });
    const stop = await runTool(context, "keel_gate", { run_id: runId, gate_id: "human:explore", answer: "stop" });
    expect(stop).toMatchObject({ ok: true, result: { next: { kind: "stop" } } });
  });

  it("different harness decides NATIVE_ROUTE_UNSUPPORTED instead of opening a Worker", async () => {
    const manual = cloneManual(DEFAULT_MANUAL);
    const grok = manual.profiles.find((p) => p.id === "grok")!;
    (grok.nodes.default as { explorer: { primary: Route } }).explorer = {
      primary: { agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy", effort: "medium" },
    };
    const { h, opts, runId } = await bootExplore({ run_id: "run-cross-harness", manual });
    const out = await advance(h, runId, { type: "tick" }, opts);
    expect(out.next.kind).toBe("decide");
    if (out.next.kind !== "decide") throw new Error("decide");
    expect(out.next.question).toMatch(/NATIVE_ROUTE_UNSUPPORTED/);
    expect(JSON.stringify(out.next)).not.toMatch(/create_worker/);
  });

  it("hidden model is not silently substituted", async () => {
    const { h, opts, runId } = await bootExplore({ run_id: "run-hidden", manual: claudeXdManual() });
    h.agentModelList = h.agentModelList.map((m) => (
      m.id === "anthropic/claude-haiku-5-5" ? { ...m, visible: false } : m
    ));
    const out = await advance(h, runId, { type: "tick" }, opts);
    expect(out.next.kind).toBe("stop");
    if (out.next.kind !== "stop") throw new Error("stop");
    expect(out.next.reason).toMatch(/全部路线不可用|清单/);
    expect(JSON.stringify(out.next)).not.toMatch(/create_worker|anthropic\/claude-sonnet/);
  });

  it("explicit effort is blocked when the catalog item has no efforts", async () => {
    const { h, runId } = await bootExplore({ run_id: "run-no-effort", manual: claudeXdManual() });
    const models = h.agentModelList.map((m) => ({ id: m.id, agent: m.agent, providerId: m.providerId }));
    const out = await advance(h, runId, { type: "tick" }, { spec: miniExploreSpec(), config: cfg(claudeXdManual()), models });
    expect(out.next.kind).toBe("stop");
    if (out.next.kind !== "stop") throw new Error("stop");
    expect(out.next.reason).toMatch(/全部路线不可用|清单/);
    expect(JSON.stringify(out.next)).not.toMatch(/create_worker/);
  });

  it("provider mismatch is not rewritten to another catalog row", async () => {
    const manual = cloneManual(DEFAULT_MANUAL);
    const grok = manual.profiles.find((p) => p.id === "grok")!;
    (grok.nodes.default as { explorer: { primary: Route } }).explorer = {
      primary: { agent: "claude-code", model: "anthropic/claude-haiku-5-5", provider_id: "art-cindy", effort: "medium" },
    };
    const { h, opts, runId } = await bootExplore({ run_id: "run-provider", manual });
    const out = await advance(h, runId, { type: "tick" }, opts);
    expect(out.next.kind).toBe("stop");
    if (out.next.kind !== "stop") throw new Error("stop");
    expect(out.next.reason).toMatch(/全部路线不可用|清单/);
    expect(JSON.stringify(out.next)).not.toMatch(/"provider_id":"xd"/);
  });

  it("successful native final requires execution_route and native_agent_id", async () => {
    const { h, opts, runId } = await bootExplore({ run_id: "run-exec", manual: claudeXdManual(), spec: PSTACK_GRAPHS.investigation });
    const d = asDispatch((await advance(h, runId, { type: "tick" }, opts)).next);
    const missing = await runTool(makeContext(h, "c-miss", emptyCtx), "keel_report", {
      run_id: runId, phase: "final", dispatch_key: d.dispatch_key, inline_report: doneReport(d.dispatch_key),
    });
    expect(missing).toMatchObject({ ok: false, errorCode: "EXECUTION_ROUTE_MISMATCH" });
    const wrong = await runTool(makeContext(h, "c-wrong", emptyCtx), "keel_report", {
      run_id: runId, phase: "final", dispatch_key: d.dispatch_key, inline_report: doneReport(d.dispatch_key),
      native_agent_id: "n1",
      execution_route: { agent: "claude-code", model: "anthropic/claude-sonnet-5-5", provider_id: "xd", effort: "medium" },
    });
    expect(wrong).toMatchObject({ ok: false, errorCode: "EXECUTION_ROUTE_MISMATCH" });
    const ok = await runTool(makeContext(h, "c-ok", emptyCtx), "keel_report", nativeFinalArgs({
      run_id: runId, dispatch: d, report: doneReport(d.dispatch_key),
    }));
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    const st = JSON.parse(h.files.get(graphStatePath(runId))!) as GraphRunState;
    expect(st.nodes.explore.actual_route).toEqual(d.subagent?.required_route);
  });

  it("agentModels ok=false does not use leftover catalog rows", async () => {
    const leftover = [{ id: "anthropic/claude-haiku-5-5", agent: "claude-code", providerId: "xd", efforts: ["medium"], visible: true }];
    const h = fakeHost({
      agentModelsResponse: { ok: false, status: 500, models: leftover },
      kv: { manual: claudeXdManual() },
      node: (method: string) => {
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "feat/x", head: HEAD } };
        if (method === "git/changed-files") return { ok: true, result: { files: [] } };
        return { ok: false, message: method };
      },
    });
    await createRun(h, {
      run_id: "run-models-fail", spec_id: "bug-fix", profile_id: "grok", lead_harness: "claude-code",
      task_type: "bug-fix", entry: "explore", goal: "fix", worktree: "/repo/.worktrees/x", now: h.now(),
    });
    const out = await advance(h, "run-models-fail", { type: "tick" }, { spec: miniExploreSpec(), config: cfg(claudeXdManual()) });
    expect(out.next.kind).toBe("stop");
    if (out.next.kind === "stop") expect(out.next.reason).toMatch(/清单为空|模型清单/);
  });

  it("keel_run rejects a profile whose harness does not match lead", async () => {
    const h = fakeHost({
      node: (method: string) => {
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "main", head: HEAD, gh_repo: "o/r" } };
        return { ok: false, message: method };
      },
    });
    const r: any = await runTool(makeContext(h, "c-mismatch", emptyCtx), "keel_run", {
      goal: "修登录报错", repo_dir: "/repo", lead: "codex", profile: "grok",
    });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("PROFILE_HARNESS_MISMATCH");
  });
});

describe("parallel native collaborators", () => {
  function collabManual(): ModelManual {
    const manual = cloneManual(DEFAULT_MANUAL);
    const grok = manual.profiles.find((p) => p.id === "grok")!;
    (grok as { lead: Route }).lead = { agent: "claude-code", model: "anthropic/claude-opus-5-5", provider_id: "xd", effort: "high" };
    (grok.nodes.default as { explorer: { primary: Route; collaborators: Route[] } }).explorer = {
      primary: { agent: "claude-code", model: "anthropic/claude-haiku-5-5", provider_id: "xd", effort: "medium" },
      collaborators: [{ agent: "claude-code", model: "anthropic/claude-sonnet-5-5", provider_id: "xd", effort: "medium" }],
    };
    return { ...manual, version: 2 };
  }

  it("dispatches subagents[] in one batch with exact models", async () => {
    const { h, opts, runId } = await bootExplore({ run_id: "run-par", manual: collabManual(), spec: PSTACK_GRAPHS.investigation });
    const d = asDispatch((await advance(h, runId, { type: "tick" }, opts)).next);
    expect(d.subagent).toBeUndefined();
    expect(d.create_worker).toBeUndefined();
    expect(d.subagents).toHaveLength(2);
    expect(d.subagents?.map((a) => a.model)).toEqual(["anthropic/claude-haiku-5-5", "anthropic/claude-sonnet-5-5"]);
    expect(d.subagents?.every((a) => a.dispatch_key.startsWith(`${runId}:explore:1/parallel/`))).toBe(true);
    expect(d.note).toMatch(/parallel_reports/);
    expect(d.note).toMatch(/不要先启动一个/);
  });

  it("rejects incomplete, mismatched, or duplicate parallel reports", async () => {
    const { h, opts, runId } = await bootExplore({ run_id: "run-par-bad", manual: collabManual(), spec: PSTACK_GRAPHS.investigation });
    const d = asDispatch((await advance(h, runId, { type: "tick" }, opts)).next);
    const arms = d.subagents!;
    const missing = await runTool(makeContext(h, "c-par-miss", emptyCtx), "keel_report", {
      run_id: runId, phase: "final", dispatch_key: d.dispatch_key,
      parallel_reports: [{
        dispatch_key: arms[0]!.dispatch_key, native_agent_id: "n1",
        execution_route: arms[0]!.required_route, report: doneReport(arms[0]!.dispatch_key),
      }],
    });
    expect(missing).toMatchObject({ ok: false, errorCode: "REPORT_INCOMPLETE" });
    const mismatch = await runTool(makeContext(h, "c-par-mis", emptyCtx), "keel_report", {
      run_id: runId, phase: "final", dispatch_key: d.dispatch_key,
      parallel_reports: [
        { dispatch_key: arms[0]!.dispatch_key, native_agent_id: "n1", execution_route: arms[0]!.required_route, report: doneReport(arms[0]!.dispatch_key) },
        { dispatch_key: arms[1]!.dispatch_key, native_agent_id: "n2", execution_route: arms[0]!.required_route, report: doneReport(arms[1]!.dispatch_key) },
      ],
    });
    expect(mismatch).toMatchObject({ ok: false, errorCode: "EXECUTION_ROUTE_MISMATCH" });
    const dup = await runTool(makeContext(h, "c-par-dup", emptyCtx), "keel_report", {
      run_id: runId, phase: "final", dispatch_key: d.dispatch_key,
      parallel_reports: [
        { dispatch_key: arms[0]!.dispatch_key, native_agent_id: "same", execution_route: arms[0]!.required_route, report: doneReport(arms[0]!.dispatch_key) },
        { dispatch_key: arms[1]!.dispatch_key, native_agent_id: "same", execution_route: arms[1]!.required_route, report: doneReport(arms[1]!.dispatch_key) },
      ],
    });
    expect(dup).toMatchObject({ ok: false, errorCode: "REPORT_INVALID" });
  });

  it("accepts a full parallel_reports set and stores the parent key", async () => {
    const { h, opts, runId } = await bootExplore({ run_id: "run-par-ok", manual: collabManual(), spec: PSTACK_GRAPHS.investigation });
    const d = asDispatch((await advance(h, runId, { type: "tick" }, opts)).next);
    const ok = await runTool(makeContext(h, "c-par-ok", emptyCtx), "keel_report", nativeFinalArgs({
      run_id: runId, dispatch: d, report: { status: "done", summary: "ok", files_changed: [], functions_touched: ["one"], ran: [] },
    }));
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    const st = JSON.parse(h.files.get(graphStatePath(runId))!) as GraphRunState;
    expect(st.nodes.explore.status).toBe("succeeded");
    expect(st.nodes.explore.dispatch_key).toBe(d.dispatch_key);
  });
});

describe("runtime config re-read", () => {
  it("next native dispatch uses the latest kv.manual instead of a cached selection", async () => {
    const first = cloneManual(DEFAULT_MANUAL);
    const { h, opts, runId } = await bootExplore({ run_id: "run-kv", profile_id: "sol", lead_harness: "codex", manual: first, spec: PSTACK_GRAPHS.investigation });
    const d = asDispatch((await advance(h, runId, { type: "tick" }, opts)).next);
    expect(d.subagent?.model).toBe("gpt-6-luna");
    const nextManual = cloneManual(first);
    (nextManual.profiles[0]!.nodes.default as { explorer: { primary: Route } }).explorer.primary = {
      agent: "codex", model: "gpt-6.1-sol", provider_id: "art-cindy", effort: "high",
    };
    h.kv.manual = nextManual;
    const failed: any = await runTool(makeContext(h, "c-kv-fail", emptyCtx), "keel_report", {
      run_id: runId, phase: "final", dispatch_key: d.dispatch_key, inline_report: { status: "failed", summary: "retry" },
    });
    expect(failed.ok, JSON.stringify(failed)).toBe(true);
    const retry = asDispatch(failed.result.next);
    expect(retry.subagent?.model).toBe("gpt-6.1-sol");
    expect(retry.subagent?.effort).toBe("high");
    expect(retry.create_worker).toBeUndefined();
  });
});
