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
    task_type: "bug-fix",
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
    expect(d.subagent).toMatchObject({ harness: "claude-code", model: "haiku", role: "keel-explorer" });
    expect(d.subagent?.route).toEqual({ model: "anthropic/claude-haiku-5-5", provider_id: "xd" });
    expect(d.note).toMatch(/subagent_type 用 keel-node/);
    expect(d.note).not.toMatch(/general-purpose/);
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
    expect(d.subagent).toMatchObject({ harness: "claude-code", model: "sonnet" });
    expect(d.create_worker).toBeUndefined();
  });

  it("default sol + codex explore stays on Orca create_worker", async () => {
    const { h, opts, runId } = await bootExplore({ profile_id: "sol", lead_harness: "codex", manual: DEFAULT_MANUAL });
    const first = await advance(h, runId, { type: "tick" }, opts);
    expect(first.next.kind).toBe("setup");
    const d = await advance(h, runId, { type: "report", phase: "setup", outcome: { worker_permission_mode: "bypassPermissions", team_id: "t1" }, session_id: "s1" }, opts);
    expect(asDispatch(d.next).create_worker).toBeTruthy();
    expect(asDispatch(d.next).subagent).toBeUndefined();
  });

  it("claude-code route that is grok-4.6 stays on Orca", async () => {
    const manual = cloneManual(DEFAULT_MANUAL);
    const grok = manual.profiles.find((p) => p.id === "grok")!;
    (grok.nodes.default as { explorer: { primary: Route } }).explorer = { primary: { agent: "claude-code", model: "grok-4.6", provider_id: "art-cindy", effort: "medium" } };
    const { h, opts, runId } = await bootExplore({ manual });
    const first = await advance(h, runId, { type: "tick" }, opts);
    expect(first.next.kind).toBe("setup");
  });

  it("claude-code opus and fable routes stay on Orca", async () => {
    for (const model of ["anthropic/claude-opus-5-5", "anthropic/claude-fable-5-1"] as const) {
      const manual = cloneManual(DEFAULT_MANUAL);
      const grok = manual.profiles.find((p) => p.id === "grok")!;
      (grok.nodes.default as { explorer: { primary: Route } }).explorer = { primary: { agent: "claude-code", model, provider_id: "xd", effort: "medium" } };
      const { h, opts, runId } = await bootExplore({ run_id: `run-${model.split("/").pop()}`, manual });
      if (!h.agentModelList.some((m) => m.id === model && m.agent === "claude-code" && m.providerId === "xd")) {
        h.agentModelList.push({ id: model, agent: "claude-code", providerId: "xd" });
      }
      const first = await advance(h, runId, { type: "tick" }, opts);
      expect(first.next.kind, model).toBe("setup");
      const d = asDispatch((await advance(h, runId, { type: "report", phase: "setup", outcome: { worker_permission_mode: "bypassPermissions", team_id: "t1" }, session_id: "s1" }, opts)).next);
      expect(d.create_worker).toBeTruthy();
      expect(d.subagent).toBeUndefined();
    }
  });

  it("write and verifier nodes stay on create_worker under the same claude-code profile", async () => {
    const { h, opts, runId } = await bootExplore({ manual: claudeXdManual() });
    const explore = asDispatch((await advance(h, runId, { type: "tick" }, opts)).next);
    const afterExplore = await advance(h, runId, { type: "report", phase: "final", dispatch_key: explore.dispatch_key, inline_report: { status: "done" }, report: { status: "done", files_changed: [], functions_touched: ["one"] } }, opts);
    expect(afterExplore.next.kind).toBe("setup");
    const worker = asDispatch((await advance(h, runId, { type: "report", phase: "setup", outcome: { worker_permission_mode: "bypassPermissions", team_id: "t1" }, session_id: "s1" }, opts)).next);
    expect(worker.create_worker?.role).toBe("keel-worker");
    expect(worker.subagent).toBeUndefined();
    await advance(h, runId, { type: "report", phase: "accepted", dispatch_key: worker.dispatch_key, worker_id: "w", worker_session_id: "ws", dispatch_outcome: { created: true, delivered: true, queued: false } }, opts);
    const afterWorker = await advance(h, runId, { type: "report", phase: "final", dispatch_key: worker.dispatch_key, inline_report: { status: "done" }, report: { status: "done", files_changed: ["src/a.ts"], functions_touched: ["one"] } }, opts);
    const verify = asDispatch(afterWorker.next);
    expect(verify.create_worker?.role).toBe("keel-verifier");
    expect(verify.subagent).toBeUndefined();
  });

  it("interrogate-architect stays on create_worker under the same claude-code profile", async () => {
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
    const runId = "run-ia";
    await createRun(h, {
      run_id: runId,
      spec_id: spec.id,
      profile_id: "grok",
      lead_harness: "claude-code",
      task_type: "feature",
      entry: "interrogate-architect",
      goal: "新增支付功能",
      worktree: "/repo/.worktrees/keel-run-ia",
      facts: { design_contested: true },
      astra_budget: 4,
      now: h.now(),
    });
    const opts = { spec, config: cfg(manual) };
    const first = await advance(h, runId, { type: "tick" }, opts);
    expect(first.next.kind).toBe("setup");
    const d = asDispatch((await advance(h, runId, { type: "report", phase: "setup", outcome: { worker_permission_mode: "bypassPermissions", team_id: "t1" }, session_id: "s1" }, opts)).next);
    expect(d.dispatch_key).toContain(":interrogate-architect:");
    expect(d.create_worker?.role).toBe("keel-architect");
    expect(d.create_worker?.agent).toBe("claude-code");
    expect(d.subagent).toBeUndefined();
  });

  it("codex lead with explorer equal to lead model returns subagent without model", async () => {
    const manual = cloneManual(DEFAULT_MANUAL);
    const sol = manual.profiles.find((p) => p.id === "sol")!;
    (sol.nodes.default as { explorer: { primary: Route } }).explorer = { primary: { agent: "codex", model: "gpt-6.1-sol", provider_id: "art-cindy", effort: "medium" } };
    const { h, opts, runId } = await bootExplore({ profile_id: "sol", lead_harness: "codex", manual });
    const d = asDispatch((await advance(h, runId, { type: "tick" }, opts)).next);
    expect(d.subagent?.harness).toBe("codex");
    expect(d.subagent).not.toHaveProperty("model");
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

  it("timebox opens human gate; late final clears it; retry attempt 2 is Orca", async () => {
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

    const { h: h2, opts: o2, runId: r2 } = await bootExplore({ run_id: "run-retry", manual: claudeXdManual() });
    asDispatch((await advance(h2, r2, { type: "tick" }, o2)).next);
    h2.clock.t += 20 * 60 * 1000;
    await advance(h2, r2, { type: "tick" }, o2);
    const afterRetry: any = await runTool(makeContext(h2, "c-retry", { lanes: [], routingPath: null, boardRepos: [], plansDir: null }), "keel_gate", {
      run_id: r2, gate_id: "human:explore", answer: "retry",
    });
    expect(afterRetry.ok, afterRetry.message).toBe(true);
    expect(afterRetry.result.next.kind).toBe("setup");
    const attempt2 = asDispatch((await advance(h2, r2, { type: "report", phase: "setup", outcome: { worker_permission_mode: "bypassPermissions", team_id: "t1" } }, o2)).next);
    expect(attempt2.dispatch_key).toBe("run-retry:explore:2");
    expect(attempt2.create_worker).toBeTruthy();
    expect(attempt2.subagent).toBeUndefined();
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
  it("queued Orca attempt after subagent timeout starts its own timebox", async () => {
    const { h, opts, runId } = await bootExplore({ run_id: "r-timeout-queue", manual: claudeXdManual() });
    const t0 = h.now();
    asDispatch((await advance(h, runId, { type: "tick" }, opts)).next);
    h.clock.t += 20 * 60 * 1000;
    const timed = await advance(h, runId, { type: "tick" }, opts);
    expect(timed.next.kind).toBe("decide");
    const afterRetry: any = await runTool(makeContext(h, "c-r43-01", { lanes: [], routingPath: null, boardRepos: [], plansDir: null }), "keel_gate", {
      run_id: runId, gate_id: "human:explore", answer: "retry",
    });
    expect(afterRetry.ok, afterRetry.message).toBe(true);
    const attempt2 = asDispatch((await advance(h, runId, { type: "report", phase: "setup", outcome: { worker_permission_mode: "bypassPermissions", team_id: "t1" }, session_id: "s1" }, opts)).next);
    expect(attempt2.dispatch_key).toBe("r-timeout-queue:explore:2");
    expect(attempt2.create_worker).toBeTruthy();
    await advance(h, runId, {
      type: "report",
      phase: "accepted",
      dispatch_key: attempt2.dispatch_key,
      worker_id: "w2",
      worker_session_id: "s2",
      queued_message_id: "q2",
      dispatch_outcome: { created: true, delivered: false, queued: true },
    }, opts);
    h.clock.t += ACCEPTED_TIMEOUT_MS;
    const rec = await advance(h, runId, { type: "tick" }, opts);
    expect(rec.next.kind).toBe("reconcile");
    const label = rec.state.nodes.explore.worker_label!;
    const runningAt = h.now();
    const recDone = await advance(h, runId, {
      type: "report",
      phase: "reconcile",
      dispatch_key: attempt2.dispatch_key,
      queries_result: {
        list_workers: {
          ok: true,
          complete: true,
          team_id: "t1",
          workers: [{ label, worker_id: "w2", worker_session_id: "s2", status: "running" }],
        },
        get_worker_queue_status: { ok: true, pending: [], consuming: true },
      },
    }, opts);
    expect(recDone.next.kind, `unexpected ${recDone.next.kind}`).toBe("wait");
    expect(recDone.state.nodes.explore.dispatch_state).toBe("running");
    expect(recDone.state.nodes.explore.started_at).toBe(runningAt);
    expect(recDone.state.nodes.explore.started_at).not.toBe(t0);
    expect(recDone.next.kind).not.toBe("recover");
  });
});

describe("R43-02 leftover plugin_task must not hijack a new Orca research attempt", () => {
  it("stay after completed plugin research clears task before create_worker", async () => {
    const spec = structuredClone(PSTACK_GRAPHS["bug-fix"]);
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
      spec_id: "bug-fix",
      profile_id: "sol",
      lead_harness: "codex",
      task_type: "bug-fix",
      entry: "research",
      goal: "fix the bug",
      worktree: "/repo/.worktrees/keel-run-sa",
      scopeAllow: ["src/**"],
      now: h.now(),
    });
    const opts: AdvanceOpts = {
      spec,
      config: cfg(DEFAULT_MANUAL),
      gates: { advance: () => "stay" },
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
    expect(afterResearch.next.kind).toBe("setup");
    const explore = asDispatch((await advance(h, runId, {
      type: "report", phase: "setup", outcome: { worker_permission_mode: "bypassPermissions", team_id: "t1" }, session_id: "s1",
    }, opts)).next);
    expect(explore.create_worker).toBeTruthy();
    await advance(h, runId, {
      type: "report", phase: "accepted", dispatch_key: explore.dispatch_key,
      worker_id: "we", worker_session_id: "se", dispatch_outcome: { created: true, delivered: true, queued: false },
    }, opts);
    const afterExplore = await advance(h, runId, {
      type: "report", phase: "final", dispatch_key: explore.dispatch_key,
      inline_report: { status: "done" }, report: { status: "done", files_changed: [], functions_touched: ["one"] },
    }, opts);
    const research2 = asDispatch(afterExplore.next);
    expect(research2.dispatch_key).toBe(`${runId}:research:2`);
    expect(research2.create_worker).toBeTruthy();
    expect(research2.plugin_task).toBeUndefined();
    expect(research2.create_worker?.initial_task).not.toMatch(/不要写 \.keel/);
    const st = JSON.parse(h.files.get(graphStatePath(runId))!) as GraphRunState;
    expect(st.nodes.research?.task).toBeUndefined();
    const acc2 = await advance(h, runId, {
      type: "report",
      phase: "accepted",
      dispatch_key: research2.dispatch_key,
      worker_id: "w-research-2",
      worker_session_id: "s-research-2",
      dispatch_outcome: { created: true, delivered: true, queued: false },
    }, opts);
    expect(acc2.next.kind, `hijacked: ${JSON.stringify(acc2.next)}`).toBe("wait");
    expect(JSON.stringify(acc2.next)).not.toMatch(/getRun|old-task-run|old-task/);
    expect(acc2.state.nodes.research?.dispatch_state).toBe("running");
    expect(acc2.state.nodes.research?.worker_id).toBe("w-research-2");
  });
});

describe("SC-2 failed subagent retries on Orca", () => {
  it("failed final on attempt 1 then retry is create_worker", async () => {
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
    expect(failed.state.nodes.explore.status).toBe("failed");
    expect(failed.state.cursor).toBe("explore");
    expect(failed.next.kind).toBe("setup");
    const attempt2 = asDispatch((await advance(h, runId, { type: "report", phase: "setup", outcome: { worker_permission_mode: "bypassPermissions", team_id: "t1" } }, opts)).next);
    expect(attempt2.dispatch_key).toBe(`${runId}:explore:2`);
    expect(attempt2.create_worker).toBeTruthy();
    expect(attempt2.subagent).toBeUndefined();
  });

  it("subagent explore failed final retries Orca instead of walking fail to stop", async () => {
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
    expect(failed.state.nodes.explore.attempts).toBe(1);
    expect(failed.next.kind).toBe("setup");
    const attempt2 = asDispatch((await advance(h, runId, {
      type: "report",
      phase: "setup",
      outcome: { worker_permission_mode: "bypassPermissions", team_id: "t1" },
    }, opts)).next);
    expect(attempt2.dispatch_key).toBe(`${runId}:explore:2`);
    expect(attempt2.create_worker).toBeTruthy();
    expect(attempt2.subagent).toBeUndefined();
  });
});

describe("nudge maps subagent dispatch to wait", () => {
  it("does not nudge while subagent is inside timebox", () => {
    const t0 = Date.UTC(2026, 9, 10, 12, 0, 0);
    const raw = {
      run_id: "r",
      status: "running",
      updated_at: t0,
      next: { kind: "dispatch", subagent: { harness: "claude-code", model: "haiku" } },
      nodes: { explore: { dispatch_state: "running", started_at: t0 } },
      spec_id: "bug-fix",
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
      next: { kind: "dispatch", subagent: { harness: "claude-code", model: "haiku" } },
      nodes: { explore: { dispatch_state: "running", started_at: t0 } },
      spec_id: "bug-fix",
    };
    const mapped = asNudgeRun(raw)!;
    expect(shouldNudge(mapped, t0 + 21 * 60_000, { turn: { endReason: "completed" } }).nudge).toBe(true);
  });
});

describe("SC-3 research is dispatch", () => {
  afterEach(cleanupRepos);

  it("bug-fix research is create_worker for default sol, never plugin_task or human:reconcile", async () => {
    const world = makeWorld();
    const host = makeE2eHost(world);
    const started = await startRun(host, {
      goal: "修登录报错", repo_dir: world.repoDir, lead: "codex", sc: [...SC], scope: ["src/**"],
    });
    const run = await leadLoop(host, started, world, { stopWhen: (_n, state) => state.cursor === "implement" || state.cursor === "architect-plan" });
    const research = run.steps.find((s) => s.kind === "dispatch" && s.dispatch_key?.includes(":research:"));
    expect(research, `steps=${JSON.stringify(run.steps.map((s) => s.kind))}`).toBeTruthy();
    if (research?.kind !== "dispatch") throw new Error("research");
    expect(research.plugin_task).toBeUndefined();
    expect(research.create_worker).toBeTruthy();
    expect(run.steps.some((s) => s.kind === "decide" && s.gate_id === "human:reconcile")).toBe(false);
    expect(["implement", "architect-plan"]).toContain(run.state.cursor);
  });

  it("claude-code xd research is subagent", async () => {
    const world = makeWorld();
    const host = makeE2eHost(world);
    host.kv.manual = claudeXdManual();
    const started = await startRun(host, {
      goal: "修登录报错", repo_dir: world.repoDir, lead: "claude-code", profile: "grok", sc: [...SC], scope: ["src/**"],
    });
    const run = await leadLoop(host, started, world, { stopWhen: (_n, state) => state.cursor === "implement" || state.cursor === "architect-plan" });
    const research = run.steps.find((s) => s.kind === "dispatch" && s.dispatch_key?.includes(":research:"));
    expect(research).toBeTruthy();
    if (research?.kind !== "dispatch") throw new Error("research");
    expect(research.plugin_task).toBeUndefined();
    expect(research.subagent?.harness).toBe("claude-code");
    expect(research.subagent?.model).toBe("haiku");
  });
});

describe("accepted error copy", () => {
  it("mentions subagent must not report accepted", async () => {
    const { h, opts, runId } = await bootExplore({ manual: claudeXdManual() });
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
