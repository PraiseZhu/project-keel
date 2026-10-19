import { afterEach, describe, expect, it } from "vitest";
import { makeContext } from "../../src/main/context.ts";
import { runTool } from "../../src/main/dispatch.ts";
import { asNudgeRun } from "../../src/main/host-bridge.ts";
import { advance, createRun, type AdvanceOpts } from "../../src/main/graph/interpreter.ts";
import { shouldNudge } from "../../src/main/graph/nudge.ts";
import { ACCEPTED_TIMEOUT_MS, PLANNED_TIMEOUT_MS, type GraphRunState, type Next } from "../../src/main/graph/state.ts";
import { cloneManual, DEFAULT_MANUAL, type ModelManual, type Profile, type Route } from "../../src/shared/manual/schema.ts";
import { LEAD_DEFAULT_PROVIDER, RESEARCH_PARALLEL } from "../../src/shared/manual/stages.ts";
import { PSTACK_GRAPHS } from "../../src/shared/graph/pstack.ts";
import type { GraphSpec } from "../../src/shared/graph/spec.ts";
import { graphStatePath, withRun } from "../../src/main/store/runs.ts";
import {
  cleanupRepos,
  executionRouteOf,
  leadLoop,
  makeE2eHost,
  makeWorld,
  nativeFinalArgs,
  SC,
  startRun,
} from "../e2e/helpers.ts";
import { fakeHost, type FakeHost } from "../helpers/fakeHost.ts";
import { pluginResearchManual } from "./helpers.ts";

const HEAD = "a".repeat(40);
const emptyCtx = { lanes: [], routingPath: null, boardRepos: [], plansDir: null };

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function profileOf(manual: ModelManual, id: string): Mutable<Profile> {
  return manual.profiles.find((p) => p.id === id) as Mutable<Profile>;
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
  entry?: string;
  worktree?: string;
  models?: AdvanceOpts["models"];
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
    entry: over.entry ?? spec.entry,
    goal: "fix the bug",
    worktree: over.worktree ?? "/repo/.worktrees/keel-run-sa",
    scopeAllow: ["src/**"],
    now: h.now(),
  });
  return { h, spec, opts: { spec, config: cfg(manual), ...(over.models ? { models: over.models } : {}) }, runId };
}

function asDispatch(next: Next): Extract<Next, { kind: "dispatch" }> {
  if (next.kind !== "dispatch") throw new Error(`expected dispatch, got ${next.kind}`);
  return next;
}

/** The three parallel 查资料 subs of a dispatch. */
function armsOf(next: Next) {
  const d = asDispatch(next);
  expect(d.subagent).toBeUndefined();
  expect(d.create_worker).toBeUndefined();
  expect(d.subagents).toHaveLength(RESEARCH_PARALLEL);
  return d.subagents!;
}

const setupReport = { type: "report", phase: "setup", outcome: { worker_permission_mode: "bypassPermissions", team_id: "t1" }, session_id: "s1" } as const;

describe("查资料 runs on the lead's own subs", () => {
  it("claude-code lead: three parallel haiku subs, no Worker and no team setup", async () => {
    const { h, opts, runId } = await bootExplore();
    const out = await advance(h, runId, { type: "tick" }, opts);
    const d = asDispatch(out.next);
    const arms = armsOf(out.next);
    expect(d.dispatch_key).toBe(`${runId}:explore:1`);
    expect(arms.map((a) => a.dispatch_key)).toEqual([1, 2, 3].map((n) => `${runId}:explore:1/parallel/${n}`));
    for (const arm of arms) {
      expect(arm).toMatchObject({ harness: "claude-code", model: "haiku", role: "keel-explorer", require_exact_route: false });
      expect(arm.route).toEqual({ model: "haiku", provider_id: LEAD_DEFAULT_PROVIDER });
      expect(arm.required_route).toEqual({ agent: "claude-code", model: "haiku", provider_id: LEAD_DEFAULT_PROVIDER });
      expect("effort" in arm).toBe(false);
    }
    expect(new Set(arms.map((a) => a.report_path)).size).toBe(3);
    expect(arms.map((a) => a.report_path)).toEqual([1, 2, 3].map((n) => expect.stringMatching(new RegExp(`\\.keel/explore-1-parallel-${n}\\.md$`))));
    expect(d.note).toMatch(/haiku/);
    expect(d.note).toMatch(/失败后也不自动转 Worker/);
    expect(d.note).toMatch(/parallel_reports/);
    expect(d.note).toMatch(/不要先启动一个/);
    expect(d.note).not.toMatch(/NATIVE_ROUTE_UNSUPPORTED/);
    expect(d.after).toBe("keel_report phase=final");
    const node = out.state.nodes.explore;
    expect(node.dispatch_state).toBe("running");
    expect(node.planned_params).toMatchObject({ channel: "subagent", agent: "claude-code", model: "haiku", provider_id: LEAD_DEFAULT_PROVIDER, writes: false });
    expect(node.planned_params?.effort).toBeUndefined();
    expect(node.collaborators?.map((c) => c.dispatch_key)).toEqual(arms.map((a) => a.dispatch_key));
    expect(node.team_id).toBeUndefined();
    expect(out.state.team?.ready).not.toBe(true);
    expect(out.state.astra_calls).toBe(0);
  });

  it("codex lead: three parallel gpt-6-luna subs", async () => {
    const { h, opts, runId } = await bootExplore({ profile_id: "sol", lead_harness: "codex" });
    const out = await advance(h, runId, { type: "tick" }, opts);
    const arms = armsOf(out.next);
    for (const arm of arms) {
      expect(arm).toMatchObject({ harness: "codex", model: "gpt-6-luna", role: "keel-explorer", require_exact_route: false });
      expect(arm.required_route).toEqual({ agent: "codex", model: "gpt-6-luna", provider_id: LEAD_DEFAULT_PROVIDER });
    }
    expect(asDispatch(out.next).note).toMatch(/gpt-6-luna/);
    expect(out.state.team?.ready).not.toBe(true);
  });

  it("ignores explorer / researcher slots in the manual: the route only follows the lead harness", async () => {
    const manual = cloneManual(DEFAULT_MANUAL);
    const sonnet: Route = { agent: "claude-code", model: "anthropic/claude-sonnet-5-5", provider_id: "xd", effort: "medium" };
    profileOf(manual, "grok").nodes = { default: { ...profileOf(manual, "grok").nodes.default, explorer: { primary: sonnet }, researcher: { primary: sonnet } } };
    profileOf(manual, "sol").nodes = {
      default: { ...profileOf(manual, "sol").nodes.default, explorer: { primary: { agent: "codex", model: "gpt-6.1-sol", provider_id: "art-cindy", effort: "high" } } },
    };
    const claude = await bootExplore({ run_id: "run-ignore-cc", manual });
    expect(armsOf((await advance(claude.h, claude.runId, { type: "tick" }, claude.opts)).next).map((a) => a.model)).toEqual(Array(3).fill("haiku"));
    const codex = await bootExplore({ run_id: "run-ignore-cx", manual, profile_id: "sol", lead_harness: "codex" });
    expect(armsOf((await advance(codex.h, codex.runId, { type: "tick" }, codex.opts)).next).map((a) => a.model)).toEqual(Array(3).fill("gpt-6-luna"));
  });

  it("explorer and researcher split the read by different angles, one angle per sub", async () => {
    const explore = await bootExplore({ run_id: "run-angle-e", spec: PSTACK_GRAPHS.investigation });
    const researchStart = await bootExplore({ run_id: "run-angle-r", spec: PSTACK_GRAPHS.investigation, entry: "research" });
    const eTasks = armsOf((await advance(explore.h, explore.runId, { type: "tick" }, explore.opts)).next).map((a) => a.task);
    const rTasks = armsOf((await advance(researchStart.h, researchStart.runId, { type: "tick" }, researchStart.opts)).next).map((a) => a.task);
    expect(eTasks.map((t, i) => t.includes(`并行 ${i + 1}/3`))).toEqual([true, true, true]);
    expect(eTasks[0]).toMatch(/代码位置与调用链/);
    expect(eTasks[1]).toMatch(/测试与配置/);
    expect(eTasks[2]).toMatch(/历史与文档/);
    expect(rTasks[0]).toMatch(/官方文档与接口/);
    expect(rTasks[1]).toMatch(/仓内已有用法/);
    expect(rTasks[2]).toMatch(/已知问题与限制/);
    for (const task of eTasks) for (const other of ["官方文档与接口", "仓内已有用法", "已知问题与限制"]) expect(task).not.toContain(other);
    // Each sub reports under its own key, never the parent's.
    expect(eTasks[0]).toContain("run-angle-e:explore:1/parallel/1");
    expect(eTasks[0]).not.toContain("explore:1/parallel/2");
  });

  it("does not depend on the model catalog: empty, unreadable, or hidden entries do not stop 查资料", async () => {
    const empty = await bootExplore({ run_id: "run-cat-empty", models: [] });
    expect(armsOf((await advance(empty.h, empty.runId, { type: "tick" }, empty.opts)).next)).toHaveLength(3);

    const h = fakeHost({
      agentModelsResponse: { ok: false, status: 500, models: [{ id: "haiku", agent: "claude-code", providerId: "xd", efforts: ["medium"], visible: true }] },
      kv: { manual: DEFAULT_MANUAL },
      node: (method: string) => {
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "feat/x", head: HEAD } };
        if (method === "git/changed-files") return { ok: true, result: { files: [] } };
        return { ok: false, message: method };
      },
    });
    await createRun(h, { run_id: "run-cat-fail", spec_id: "bug-fix", profile_id: "grok", lead_harness: "claude-code", task_type: "bug-fix", entry: "explore", goal: "fix", worktree: "/repo/.worktrees/x", now: h.now() });
    expect(armsOf((await advance(h, "run-cat-fail", { type: "tick" }, { spec: miniExploreSpec(), config: cfg(DEFAULT_MANUAL) })).next)).toHaveLength(3);

    const hidden = await bootExplore({ run_id: "run-cat-hidden" });
    hidden.h.agentModelList = hidden.h.agentModelList.map((m) => ({ ...m, visible: false }));
    expect(armsOf((await advance(hidden.h, hidden.runId, { type: "tick" }, hidden.opts)).next)).toHaveLength(3);
  });

  it("pi lead has no usable sub: a human gate right away, no team setup and no Worker", async () => {
    const { h, opts, runId } = await bootExplore({ profile_id: "sol", lead_harness: "pi" });
    const out = await advance(h, runId, { type: "tick" }, opts);
    expect(out.next.kind).toBe("decide");
    if (out.next.kind !== "decide") throw new Error("decide");
    expect(out.next.gate_id).toBe("human:explore");
    expect(out.next.question).toMatch(/主控自带子助手/);
    expect(out.next.question).toMatch(/pi/);
    expect(out.next.options).toEqual(["stop"]);
    expect(JSON.stringify(out.next)).not.toMatch(/create_worker|NATIVE_ROUTE_UNSUPPORTED/);
    expect(out.state.team?.ready).not.toBe(true);
    expect(out.state.nodes.explore?.dispatch_key).toBeUndefined();
  });

  it("the pi gate only accepts stop, ignores a queued answer that was never offered, and then stops the run", async () => {
    const { h, opts, runId } = await bootExplore({ run_id: "run-pi-gate", profile_id: "sol", lead_harness: "pi", spec: PSTACK_GRAPHS.investigation });
    const pending = await advance(h, runId, { type: "tick" }, opts);
    expect(pending.next).toMatchObject({ kind: "decide", gate_id: "human:explore", options: ["stop"] });
    const context = makeContext(h, "gate-pi", emptyCtx);
    const before = h.files.get(graphStatePath(runId));
    for (const answer of ["ok", "fail", "adopt", "retry"]) {
      const rejected = await runTool(context, "keel_gate", { run_id: runId, gate_id: "human:explore", answer });
      expect(rejected, answer).toMatchObject({ ok: false, errorCode: "INVALID_GATE_ANSWER" });
      expect(h.files.get(graphStatePath(runId))).toBe(before);
    }
    const stale = await runTool(context, "keel_gate", { run_id: runId, gate_id: "human:research", answer: "stop" });
    expect(stale).toMatchObject({ ok: false, errorCode: "GATE_NOT_PENDING" });
    expect(h.files.get(graphStatePath(runId))).toBe(before);
    const queued = JSON.parse(before!) as GraphRunState;
    queued.sol_decisions.push({ gate_id: "human:explore", answer: "ok", attempt: 0 });
    h.files.set(graphStatePath(runId), JSON.stringify(queued));
    const guarded = await advance(h, runId, { type: "tick" }, opts);
    expect(guarded.next).toMatchObject({ kind: "decide", gate_id: "human:explore" });
    expect(guarded.state.nodes.explore?.status).not.toBe("succeeded");
    expect(guarded.state.sol_decisions).toEqual([]);
    const stop = await runTool(context, "keel_gate", { run_id: runId, gate_id: "human:explore", answer: "stop" });
    expect(stop).toMatchObject({ ok: true, result: { next: { kind: "stop" } } });
  });
});

describe("想方案 / 写代码 / 做检查 run as Workers", () => {
  it("under a Claude Code lead, 写代码 and 做检查 are Workers on different harnesses, never NATIVE_ROUTE_UNSUPPORTED", async () => {
    const { h, opts, runId } = await bootExplore();
    const explore = asDispatch((await advance(h, runId, { type: "tick" }, opts)).next);
    const afterExplore = await advance(h, runId, { type: "report", phase: "final", dispatch_key: explore.dispatch_key, inline_report: { status: "done" }, report: { status: "done", files_changed: [], functions_touched: ["one"] } }, opts);
    // 查资料 needed no team, but 写代码 does.
    expect(afterExplore.next.kind).toBe("setup");
    const worker = asDispatch((await advance(h, runId, setupReport, opts)).next);
    expect(worker.subagent).toBeUndefined();
    expect(worker.create_worker).toMatchObject({ role: "keel-worker", agent: "claude-code", model: "anthropic/claude-sonnet-5-5", provider_id: "xd", effort: "high", fast: false, agent_device_id: "local" });
    await advance(h, runId, { type: "report", phase: "accepted", dispatch_key: worker.dispatch_key, worker_id: "w", worker_session_id: "ws", dispatch_outcome: { created: true, delivered: true, queued: false } }, opts);
    const afterWorker = await advance(h, runId, { type: "report", phase: "final", dispatch_key: worker.dispatch_key, inline_report: { status: "done" }, report: { status: "done", files_changed: ["src/a.ts"], functions_touched: ["one"] } }, opts);
    const verify = asDispatch(afterWorker.next);
    expect(verify.subagent).toBeUndefined();
    expect(verify.subagents).toBeUndefined();
    expect(verify.create_worker).toMatchObject({ role: "keel-verifier", agent: "codex", model: "gpt-6-astra", provider_id: "art-cindy", effort: "xhigh" });
    expect(JSON.stringify(verify)).not.toMatch(/NATIVE_ROUTE_UNSUPPORTED/);
    expect(afterWorker.state.author_agents).toEqual(["claude-code"]);
    expect(afterWorker.state.budget.astra_left).toBe(4);
    expect(afterWorker.state.astra_calls).toBe(0);
  });

  it("feature architect-plan is one Worker on the other harness, needs a team, and costs one astra point", async () => {
    const spec = PSTACK_GRAPHS.feature;
    const h = fakeHost({
      kv: { manual: DEFAULT_MANUAL },
      node: (method: string) => {
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "feat/x", head: HEAD } };
        if (method === "git/changed-files") return { ok: true, result: { files: [] } };
        return { ok: false, message: method };
      },
    });
    const runId = "run-ap";
    await createRun(h, {
      run_id: runId, spec_id: spec.id, profile_id: "grok", lead_harness: "claude-code", task_type: "feature",
      entry: "architect-plan", goal: "新增支付功能", worktree: "/repo/.worktrees/keel-run-ap", astra_budget: 4, now: h.now(),
    });
    const opts = { spec, config: cfg(DEFAULT_MANUAL) };
    const first = await advance(h, runId, { type: "tick" }, opts);
    expect(first.next.kind).toBe("setup");
    expect(first.state.astra_calls).toBe(0);
    const out = await advance(h, runId, setupReport, opts);
    const d = asDispatch(out.next);
    expect(d.dispatch_key).toContain(":architect-plan:");
    expect(d.subagent).toBeUndefined();
    expect(d.subagents).toBeUndefined();
    expect(d.create_worker).toMatchObject({ role: "keel-architect", agent: "codex", model: "gpt-6-astra", provider_id: "art-cindy", effort: "xhigh" });
    expect(out.state.astra_calls).toBe(1);
    expect(out.state.budget.astra_left).toBe(3);
    expect(out.state.nodes["architect-plan"]?.collaborators).toBeUndefined();
  });

  it("astra-unstick is one Worker too, charged one astra point even when collaborators are stored", async () => {
    const manual = cloneManual(DEFAULT_MANUAL);
    const grok = profileOf(manual, "grok");
    const architect = grok.nodes.default!.architect!;
    grok.nodes = { default: { ...grok.nodes.default, architect: { ...architect, collaborators: [architect.primary, architect.primary] } } };
    const spec = PSTACK_GRAPHS["bug-fix"];
    const { h, opts, runId } = await bootExplore({ run_id: "run-unstick", manual: { ...manual, version: 2 }, spec, entry: "astra-unstick" });
    // astra-unstick only runs once the same failure repeated twice.
    await withRun(h, runId, (raw) => {
      (raw as unknown as GraphRunState).fingerprints.push({ node: "implement", signature: "npx vitest run", count: 2 });
    });
    const first = await advance(h, runId, { type: "tick" }, opts);
    expect(first.next.kind).toBe("setup");
    const out = await advance(h, runId, setupReport, opts);
    const d = asDispatch(out.next);
    expect(d.subagents).toBeUndefined();
    expect(d.create_worker).toMatchObject({ role: "keel-architect", agent: "codex", model: "gpt-6-astra" });
    expect(out.state.astra_calls).toBe(1);
    expect(out.state.budget.astra_left).toBe(3);
    expect(out.state.nodes["astra-unstick"]?.collaborators).toBeUndefined();
  });
});

describe("做检查 route selection", () => {
  async function verifyWith(manual: ModelManual, patch: (state: GraphRunState) => void, over: { profile_id?: string; lead_harness?: "codex" | "claude-code"; models?: AdvanceOpts["models"] } = {}) {
    const { h, opts, runId } = await bootExplore({ run_id: "run-review", manual, entry: "verify", models: over.models, profile_id: over.profile_id ?? "grok", lead_harness: over.lead_harness ?? "claude-code" });
    await withRun(h, runId, (raw) => patch(raw as unknown as GraphRunState));
    const first = await advance(h, runId, { type: "tick" }, opts);
    expect(first.next.kind).toBe("setup");
    return advance(h, runId, setupReport, opts);
  }

  it("skips a route on a harness that wrote code and takes the next fallback, with a note", async () => {
    const manual = cloneManual(DEFAULT_MANUAL);
    const grok = profileOf(manual, "grok");
    grok.final_review_route = { agent: "claude-code", model: "anthropic/claude-opus-5-5", provider_id: "xd", effort: "xhigh" };
    grok.final_review_fallbacks = [{ agent: "codex", model: "gpt-6-astra", provider_id: "art-cindy", effort: "xhigh" }];
    const out = await verifyWith(manual, (s) => { s.author_agents = ["claude-code"]; s.author_families = ["claude"]; });
    const d = asDispatch(out.next);
    expect(d.create_worker).toMatchObject({ role: "keel-verifier", agent: "codex", model: "gpt-6-astra" });
    expect(d.note).toMatch(/主路线 anthropic\/claude-opus-5-5 不可用，改用 gpt-6-astra/);
  });

  it("final_review_fallbacks are tried in order when the primary is unavailable", async () => {
    const noAstra = fakeHost().agentModelList.filter((m) => m.id !== "gpt-6-astra");
    const out = await verifyWith(DEFAULT_MANUAL, (s) => { s.author_agents = ["claude-code"]; s.author_families = ["claude"]; }, { models: noAstra });
    expect(asDispatch(out.next).create_worker).toMatchObject({ agent: "codex", model: "openai/gpt-6-astra", provider_id: "xd" });
  });

  it("stops with the framework message when every route runs on a harness that wrote code", async () => {
    const out = await verifyWith(DEFAULT_MANUAL, (s) => { s.author_agents = ["claude-code", "codex"]; s.author_families = []; });
    expect(out.next.kind).toBe("stop");
    if (out.next.kind !== "stop") throw new Error("stop");
    expect(out.next.reason).toBe("没有与写代码不同执行框架、不同模型族的检查路线");
    expect(JSON.stringify(out.next)).not.toMatch(/create_worker/);
  });

  it("a Codex lead's writer on Codex leaves only the Claude Code review routes", async () => {
    const out = await verifyWith(DEFAULT_MANUAL, (s) => { s.author_agents = ["codex"]; s.author_families = ["gpt"]; }, { profile_id: "sol", lead_harness: "codex" });
    expect(asDispatch(out.next).create_worker).toMatchObject({ agent: "claude-code", model: "anthropic/claude-opus-5-5" });
    const noOpus = fakeHost().agentModelList.filter((m) => m.id !== "anthropic/claude-opus-5-5");
    const backup = await verifyWith(DEFAULT_MANUAL, (s) => { s.author_agents = ["codex"]; s.author_families = ["gpt"]; }, { profile_id: "sol", lead_harness: "codex", models: noOpus });
    expect(asDispatch(backup.next).create_worker).toMatchObject({ agent: "claude-code", model: "anthropic/claude-sonnet-5-5" });
  });

  it("the family rule still applies on top of the framework rule", async () => {
    const manual = cloneManual(DEFAULT_MANUAL);
    const sol = profileOf(manual, "sol");
    // claude-code route with a GPT family model: framework differs from the Codex writer, family does not.
    sol.final_review_route = { agent: "claude-code", model: "openai/gpt-6-astra", provider_id: "xd", effort: "xhigh" };
    delete sol.final_review_fallbacks;
    const models = [...fakeHost().agentModelList, { id: "openai/gpt-6-astra", agent: "claude-code", providerId: "xd", efforts: ["xhigh"], visible: true }];
    const out = await verifyWith(manual, (s) => { s.author_agents = ["codex"]; s.author_families = ["gpt"]; }, { profile_id: "sol", lead_harness: "codex", models });
    expect(out.next.kind).toBe("stop");
    if (out.next.kind === "stop") expect(out.next.reason).toBe("没有与写代码不同执行框架、不同模型族的检查路线");
  });
});

describe("写代码 route availability", () => {
  async function workerRun(manual: ModelManual, patchCatalog: (h: FakeHost) => void = () => {}) {
    const boot = await bootExplore({ run_id: "run-writer", manual, entry: "worker" });
    patchCatalog(boot.h);
    const first = await advance(boot.h, boot.runId, { type: "tick" }, boot.opts);
    expect(first.next.kind).toBe("setup");
    return advance(boot.h, boot.runId, setupReport, boot.opts);
  }

  it("a hidden primary falls back to the declared backup and says so; both hidden stops without substituting", async () => {
    const hide = (...ids: string[]) => (h: FakeHost) => { h.agentModelList = h.agentModelList.map((m) => (ids.includes(m.id) ? { ...m, visible: false } : m)); };
    const viaBackup = await workerRun(DEFAULT_MANUAL, hide("anthropic/claude-sonnet-5-5"));
    const d = asDispatch(viaBackup.next);
    expect(d.create_worker).toMatchObject({ agent: "claude-code", model: "anthropic/claude-opus-5-5" });
    expect(d.note).toMatch(/主路线 anthropic\/claude-sonnet-5-5 不可用，改用 anthropic\/claude-opus-5-5/);

    const none = await workerRun(DEFAULT_MANUAL, hide("anthropic/claude-sonnet-5-5", "anthropic/claude-opus-5-5"));
    expect(none.next.kind).toBe("stop");
    if (none.next.kind !== "stop") throw new Error("stop");
    expect(none.next.reason).toMatch(/全部路线不可用/);
    expect(JSON.stringify(none.next)).not.toMatch(/create_worker|haiku/);
  });

  it("an explicit effort is blocked when the catalog item declares no efforts, and a provider mismatch is not rewritten", async () => {
    const noEfforts = await workerRun(DEFAULT_MANUAL, (h) => { h.agentModelList = h.agentModelList.map((m) => ({ id: m.id, agent: m.agent, providerId: m.providerId })); });
    expect(noEfforts.next.kind).toBe("stop");
    if (noEfforts.next.kind === "stop") expect(noEfforts.next.reason).toMatch(/全部路线不可用/);

    const manual = cloneManual(DEFAULT_MANUAL);
    profileOf(manual, "grok").nodes = {
      default: { ...profileOf(manual, "grok").nodes.default, worker: { primary: { agent: "claude-code", model: "anthropic/claude-sonnet-5-5", provider_id: "art-cindy", effort: "high" } } },
    };
    const mismatch = await workerRun(manual);
    expect(mismatch.next.kind).toBe("stop");
    if (mismatch.next.kind === "stop") expect(mismatch.next.reason).toMatch(/全部路线不可用/);
    expect(JSON.stringify(mismatch.next)).not.toMatch(/"provider_id":"xd"/);
  });

  it("an unreadable catalog stops 写代码 instead of using leftover rows", async () => {
    const leftover = [{ id: "anthropic/claude-sonnet-5-5", agent: "claude-code", providerId: "xd", efforts: ["high"], visible: true }];
    const h = fakeHost({
      agentModelsResponse: { ok: false, status: 500, models: leftover },
      kv: { manual: DEFAULT_MANUAL },
      node: (method: string) => {
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "feat/x", head: HEAD } };
        if (method === "git/changed-files") return { ok: true, result: { files: [] } };
        return { ok: false, message: method };
      },
    });
    await createRun(h, { run_id: "run-models-fail", spec_id: "bug-fix", profile_id: "grok", lead_harness: "claude-code", task_type: "bug-fix", entry: "worker", goal: "fix", worktree: "/repo/.worktrees/x", now: h.now() });
    const spec = miniExploreSpec();
    await advance(h, "run-models-fail", { type: "tick" }, { spec, config: cfg(DEFAULT_MANUAL) });
    const out = await advance(h, "run-models-fail", setupReport, { spec, config: cfg(DEFAULT_MANUAL) });
    expect(out.next.kind).toBe("stop");
    if (out.next.kind === "stop") expect(out.next.reason).toMatch(/清单为空|模型清单/);
  });
});

describe("SC-2 subagent in-flight and retry", () => {
  it("in-flight wait does not reconcile; accepted throws; final advances", async () => {
    const { h, opts, runId } = await bootExplore();
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
    expect(fin.state.author_agents ?? []).toEqual([]);
    expect(fin.next.kind).toBe("setup");
    const worker = asDispatch((await advance(h, runId, setupReport, opts)).next);
    expect(worker.create_worker).toBeTruthy();
  });

  it("timebox opens human gate; late final clears it; retry attempt 2 stays native", async () => {
    const { h, opts, runId } = await bootExplore();
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
    const { h: h2, opts: o2, runId: r2 } = await bootExplore({ run_id: "run-retry", spec: PSTACK_GRAPHS.investigation });
    asDispatch((await advance(h2, r2, { type: "tick" }, o2)).next);
    h2.clock.t += 20 * 60 * 1000;
    await advance(h2, r2, { type: "tick" }, o2);
    const afterRetry: any = await runTool(makeContext(h2, "c-retry", emptyCtx), "keel_gate", {
      run_id: r2, gate_id: "human:explore", answer: "retry",
    });
    expect(afterRetry.ok, afterRetry.message).toBe(true);
    const attempt2 = asDispatch(afterRetry.result.next);
    expect(attempt2.dispatch_key).toBe("run-retry:explore:2");
    expect(armsOf(attempt2).map((a) => a.dispatch_key)).toEqual([1, 2, 3].map((n) => `run-retry:explore:2/parallel/${n}`));
    expect(armsOf(attempt2).every((a) => a.harness === "claude-code" && a.model === "haiku")).toBe(true);
  });

  it("keel_wait on a subagent in-flight node returns wait, not reconcile", async () => {
    const { h, opts, runId } = await bootExplore();
    await advance(h, runId, { type: "tick" }, opts);
    const waited: any = await runTool(makeContext(h, "c1", emptyCtx), "keel_wait", { run_id: runId });
    expect(waited.ok).toBe(true);
    expect(waited.result.next.kind).toBe("wait");
    expect(JSON.stringify(waited.result)).not.toMatch(/reconcile|list_workers/);
  });
});

describe("R43-01 subagent timeout retry must not inherit started_at", () => {
  it("native retry after subagent timeout starts its own timebox", async () => {
    const { h, opts, runId } = await bootExplore({ run_id: "r-timeout-queue", spec: PSTACK_GRAPHS.investigation });
    const t0 = h.now();
    asDispatch((await advance(h, runId, { type: "tick" }, opts)).next);
    h.clock.t += 20 * 60 * 1000;
    const timed = await advance(h, runId, { type: "tick" }, opts);
    expect(timed.next.kind).toBe("decide");
    const afterRetry: any = await runTool(makeContext(h, "c-r43-01", emptyCtx), "keel_gate", {
      run_id: runId, gate_id: "human:explore", answer: "retry",
    });
    expect(afterRetry.ok, afterRetry.message).toBe(true);
    const attempt2 = asDispatch(afterRetry.result.next);
    expect(attempt2.dispatch_key).toBe("r-timeout-queue:explore:2");
    expect(armsOf(attempt2)).toHaveLength(3);
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

describe("R43-02 leftover plugin_task must not hijack a new 查资料 attempt", () => {
  it("returning to research after a completed plugin research clears task before the native subs", async () => {
    // Change graphs no longer have read-only research; loop the investigation graph back to explore so research runs twice.
    const spec = structuredClone(PSTACK_GRAPHS.investigation);
    spec.edges = spec.edges.map((e) => (e.from === "research" && e.on === "ok" ? { ...e, to: "explore" } : e));
    const researchNode = spec.nodes.find((n) => n.id === "research");
    if (!researchNode) throw new Error("research");
    researchNode.kind = "plugin_task";
    const manual = pluginResearchManual();
    const h = fakeHost({
      kv: { manual },
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
    const opts: AdvanceOpts = { spec, config: cfg(manual) };
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
    expect(armsOf(explore)).toHaveLength(3);
    const afterExplore = await advance(h, runId, {
      type: "report", phase: "final", dispatch_key: explore.dispatch_key,
      inline_report: { status: "done" }, report: { status: "done", files_changed: [], functions_touched: ["one"] },
    }, opts);
    const research2 = asDispatch(afterExplore.next);
    expect(research2.dispatch_key).toBe(`${runId}:research:2`);
    expect(research2.create_worker).toBeUndefined();
    expect(research2.plugin_task).toBeUndefined();
    const arms = armsOf(research2);
    expect(arms[0]).toMatchObject({ harness: "codex", model: "gpt-6-luna" });
    expect(arms[0]!.task).not.toMatch(/不要写 \.keel\/ 文件，也不要调用 keel_report/);
    expect(arms[0]!.task).toMatch(/主控会把它原样交给 KEEL/);
    const st = JSON.parse(h.files.get(graphStatePath(runId))!) as GraphRunState;
    expect(st.nodes.research?.task).toBeUndefined();
    const acc2: any = await runTool(makeContext(h, "c-r43-02", emptyCtx), "keel_report", {
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
  it("failed final on attempt 1 then retry is still three native subs", async () => {
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
    const { h, opts, runId } = await bootExplore({ spec });
    const d = asDispatch((await advance(h, runId, { type: "tick" }, opts)).next);
    const failed = await advance(h, runId, { type: "report", phase: "final", dispatch_key: d.dispatch_key, inline_report: { status: "failed" }, report: { status: "failed" } }, opts);
    expect(failed.state.cursor).toBe("explore");
    const attempt2 = asDispatch(failed.next);
    expect(attempt2.dispatch_key).toBe(`${runId}:explore:2`);
    expect(armsOf(attempt2)).toHaveLength(3);
    expect(failed.state.nodes.explore.status).toBe("active");
  });

  it("subagent explore failed final retries native instead of walking fail to stop", async () => {
    const { h, opts, runId } = await bootExplore();
    const d = asDispatch((await advance(h, runId, { type: "tick" }, opts)).next);
    expect(armsOf(d)).toHaveLength(3);
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
    expect(armsOf(attempt2)).toHaveLength(3);
  });
});

describe("nudge maps subagent dispatch to wait", () => {
  const t0 = Date.UTC(2026, 9, 10, 12, 0, 0);
  const runWith = (next: Record<string, unknown>) => ({
    run_id: "r",
    status: "running",
    updated_at: t0,
    next,
    nodes: { explore: { dispatch_state: "running", started_at: t0 } },
    spec_id: "investigation",
  });

  it("does not nudge while a single subagent is inside timebox", () => {
    const mapped = asNudgeRun(runWith({ kind: "dispatch", subagent: { harness: "claude-code", model: "haiku" } }))!;
    expect(mapped.next?.kind).toBe("wait");
    expect(shouldNudge(mapped, t0 + 1000, { turn: { endReason: "completed" } }).nudge).toBe(false);
  });

  it("does not nudge while the three parallel 查资料 subs are inside timebox", () => {
    const mapped = asNudgeRun(runWith({ kind: "dispatch", subagents: [{ harness: "claude-code", model: "haiku" }, { harness: "claude-code", model: "haiku" }, { harness: "claude-code", model: "haiku" }] }))!;
    expect(mapped.next?.kind).toBe("wait");
    expect(shouldNudge(mapped, t0 + 1000, { turn: { endReason: "completed" } }).nudge).toBe(false);
  });

  it("nudges after timebox", () => {
    for (const next of [
      { kind: "dispatch", subagent: { harness: "claude-code", model: "haiku" } },
      { kind: "dispatch", subagents: [{ harness: "claude-code", model: "haiku" }] },
    ]) {
      const mapped = asNudgeRun(runWith(next))!;
      expect(shouldNudge(mapped, t0 + 21 * 60_000, { turn: { endReason: "completed" } }).nudge).toBe(true);
    }
  });

  it("still treats a Worker dispatch as a lead action", () => {
    const mapped = asNudgeRun(runWith({ kind: "dispatch", create_worker: { label: "keel-x" } }))!;
    expect(mapped.next?.kind).toBe("dispatch");
  });
});

describe("SC-3 research is dispatch", () => {
  afterEach(cleanupRepos);

  // Change graphs no longer have a research node; only the investigation graph does.
  it("investigation research is the lead's own three subs for default sol, never plugin_task or human:reconcile", async () => {
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
    expect(research.subagents).toHaveLength(3);
    expect(research.subagents!.every((a) => a.harness === "codex" && a.model === "gpt-6-luna")).toBe(true);
    expect(run.steps.some((s) => s.kind === "decide" && s.gate_id === "human:reconcile")).toBe(false);
    expect(run.steps.some((s) => s.kind === "setup")).toBe(false);
    expect(run.state.cursor).toBe("report");
  });

  it("claude-code lead research is three haiku subs", async () => {
    const world = makeWorld();
    const host = makeE2eHost(world);
    const started = await startRun(host, {
      goal: "调查登录报错", repo_dir: world.repoDir, lead: "claude-code", profile: "grok", playbook: "investigation", sc: [...SC],
    });
    const run = await leadLoop(host, started, world, { stopWhen: (_n, state) => state.cursor === "report" });
    const research = run.steps.find((s) => s.kind === "dispatch" && s.dispatch_key?.includes(":research:"));
    expect(research).toBeTruthy();
    if (research?.kind !== "dispatch") throw new Error("research");
    expect(research.plugin_task).toBeUndefined();
    expect(research.subagents).toHaveLength(3);
    expect(research.subagents!.every((a) => a.harness === "claude-code" && a.model === "haiku")).toBe(true);
    expect(research.subagents!.map((a) => a.dispatch_key)).toEqual([1, 2, 3].map((n) => `${research.dispatch_key}/parallel/${n}`));
  });
});

describe("accepted error copy", () => {
  it("mentions subagent must not report accepted", async () => {
    // keel_report loads the real spec by spec_id; explore lives only in the investigation graph.
    const { h, opts, runId } = await bootExplore({ spec: PSTACK_GRAPHS.investigation });
    const d = asDispatch((await advance(h, runId, { type: "tick" }, opts)).next);
    await expect(
      runTool(makeContext(h, "c-acc", emptyCtx), "keel_report", {
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

describe("keel_run", () => {
  it("rejects a profile whose harness does not match lead", async () => {
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

describe("查资料 reports: parallel_reports and the lead-default route check", () => {
  /** A real sub reports whatever model and gateway it actually ran on. */
  const actualRoute = (agent: "claude-code" | "codex"): Route => (agent === "claude-code"
    ? { agent, model: "claude-haiku-4-5-20251001", provider_id: "xd", effort: "low" }
    : { agent, model: "gpt-6-luna", provider_id: "art-cindy", effort: "medium" });

  async function researchRun(runId: string, lead: { profile_id: string; lead_harness: "codex" | "claude-code" } = { profile_id: "grok", lead_harness: "claude-code" }) {
    const boot = await bootExplore({ run_id: runId, spec: PSTACK_GRAPHS.investigation, ...lead });
    const d = asDispatch((await advance(boot.h, boot.runId, { type: "tick" }, boot.opts)).next);
    return { ...boot, d, arms: armsOf(d) };
  }

  const parallel = (arms: readonly { dispatch_key: string }[], route: Route, over: (index: number) => Record<string, unknown> = () => ({})) => arms.map((arm, index) => ({
    dispatch_key: arm.dispatch_key, native_agent_id: `n${index + 1}`, execution_route: route, report: doneReport(arm.dispatch_key), ...over(index),
  }));

  it("accepts the real model and gateway of the lead's subs: only the agent is compared", async () => {
    const { h, runId, d, arms } = await researchRun("run-par-ok");
    const ok = await runTool(makeContext(h, "c-par-ok", emptyCtx), "keel_report", {
      run_id: runId, phase: "final", dispatch_key: d.dispatch_key, parallel_reports: parallel(arms, actualRoute("claude-code")),
    });
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    const st = JSON.parse(h.files.get(graphStatePath(runId))!) as GraphRunState;
    expect(st.nodes.explore.status).toBe("succeeded");
    expect(st.nodes.explore.dispatch_key).toBe(d.dispatch_key);
  });

  it("accepts the codex lead's subs on their own gateway too", async () => {
    const { h, runId, d, arms } = await researchRun("run-par-cx", { profile_id: "sol", lead_harness: "codex" });
    const ok = await runTool(makeContext(h, "c-par-cx", emptyCtx), "keel_report", {
      run_id: runId, phase: "final", dispatch_key: d.dispatch_key, parallel_reports: parallel(arms, { ...actualRoute("codex"), provider_id: "xd", model: "openai/gpt-6-luna" }),
    });
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
  });

  it("rejects a report whose sub ran on another harness than the lead, or that has no execution_route", async () => {
    const { h, runId, d, arms } = await researchRun("run-par-agent");
    const wrongAgent = await runTool(makeContext(h, "c-par-wrong", emptyCtx), "keel_report", {
      run_id: runId, phase: "final", dispatch_key: d.dispatch_key, parallel_reports: parallel(arms, actualRoute("claude-code"), (i) => (i === 1 ? { execution_route: actualRoute("codex") } : {})),
    });
    expect(wrongAgent).toMatchObject({ ok: false, errorCode: "EXECUTION_ROUTE_MISMATCH" });
    const noRoute = await runTool(makeContext(h, "c-par-none", emptyCtx), "keel_report", {
      run_id: runId, phase: "final", dispatch_key: d.dispatch_key, parallel_reports: parallel(arms, actualRoute("claude-code"), (i) => (i === 2 ? { execution_route: undefined } : {})),
    });
    expect(noRoute).toMatchObject({ ok: false, errorCode: "EXECUTION_ROUTE_MISMATCH" });
    const st = JSON.parse(h.files.get(graphStatePath(runId))!) as GraphRunState;
    expect(st.nodes.explore.status).not.toBe("succeeded");
  });

  it("rejects incomplete or duplicate parallel reports", async () => {
    const { h, runId, d, arms } = await researchRun("run-par-bad");
    const missing = await runTool(makeContext(h, "c-par-miss", emptyCtx), "keel_report", {
      run_id: runId, phase: "final", dispatch_key: d.dispatch_key, parallel_reports: parallel(arms, actualRoute("claude-code")).slice(0, 2),
    });
    expect(missing).toMatchObject({ ok: false, errorCode: "REPORT_INCOMPLETE" });
    const single = await runTool(makeContext(h, "c-par-one", emptyCtx), "keel_report", {
      run_id: runId, phase: "final", dispatch_key: d.dispatch_key, inline_report: doneReport(d.dispatch_key), native_agent_id: "n1", execution_route: actualRoute("claude-code"),
    });
    expect(single).toMatchObject({ ok: false, errorCode: "REPORT_INCOMPLETE" });
    const dup = await runTool(makeContext(h, "c-par-dup", emptyCtx), "keel_report", {
      run_id: runId, phase: "final", dispatch_key: d.dispatch_key, parallel_reports: parallel(arms, actualRoute("claude-code"), () => ({ native_agent_id: "same" })),
    });
    expect(dup).toMatchObject({ ok: false, errorCode: "REPORT_INVALID" });
  });

  it("nativeFinalArgs builds the full parallel set from the dispatch", async () => {
    const { h, runId, d } = await researchRun("run-par-helper");
    const ok = await runTool(makeContext(h, "c-par-helper", emptyCtx), "keel_report", nativeFinalArgs({
      run_id: runId, dispatch: d, report: { status: "done", summary: "ok", files_changed: [], functions_touched: ["one"], ran: [] },
    }));
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    expect(executionRouteOf(d.subagents![0]!)).toEqual({ agent: "claude-code", model: "haiku", provider_id: LEAD_DEFAULT_PROVIDER });
  });
});

describe("查资料 does not read the manual", () => {
  it("a changed kv.manual explorer slot does not move the next 查资料 attempt", async () => {
    const first = cloneManual(DEFAULT_MANUAL);
    const { h, opts, runId } = await bootExplore({ run_id: "run-kv", profile_id: "sol", lead_harness: "codex", manual: first, spec: PSTACK_GRAPHS.investigation });
    const d = asDispatch((await advance(h, runId, { type: "tick" }, opts)).next);
    expect(armsOf(d).every((a) => a.model === "gpt-6-luna")).toBe(true);
    const nextManual = cloneManual(first);
    profileOf(nextManual, "sol").nodes = {
      default: { ...profileOf(nextManual, "sol").nodes.default, explorer: { primary: { agent: "codex", model: "gpt-6.1-sol", provider_id: "art-cindy", effort: "high" } } },
    };
    h.kv.manual = nextManual;
    const failed: any = await runTool(makeContext(h, "c-kv-fail", emptyCtx), "keel_report", {
      run_id: runId, phase: "final", dispatch_key: d.dispatch_key,
      parallel_reports: armsOf(d).map((arm) => ({ dispatch_key: arm.dispatch_key, report: { dispatch_key: arm.dispatch_key, status: "failed", summary: "retry", files_changed: [], ran: [] } })),
    });
    expect(failed.ok, JSON.stringify(failed)).toBe(true);
    const retry = asDispatch(failed.result.next);
    expect(retry.dispatch_key).toBe(`${runId}:explore:2`);
    expect(armsOf(retry).every((a) => a.model === "gpt-6-luna" && a.harness === "codex")).toBe(true);
  });
});
