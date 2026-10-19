import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../../src/main/config.ts";
import { makeContext } from "../../src/main/context.ts";
import { runTool } from "../../src/main/dispatch.ts";
import { ASTRA_CONSULT_ID, advance, createRun } from "../../src/main/graph/interpreter.ts";
import { graphStatePath, withRun } from "../../src/main/store/runs.ts";
import type { GraphRunState } from "../../src/main/graph/state.ts";
import { PSTACK_GRAPHS } from "../../src/shared/graph/pstack.ts";
import { cloneManual, DEFAULT_MANUAL, type AgentModel, type ModelManual, type Profile, type Route } from "../../src/shared/manual/schema.ts";
import { DEFAULT_THRESHOLDS } from "../../src/shared/types.ts";
import { fakeHost, typesafeAnswering } from "../helpers/fakeHost.ts";
import { appendixCAgentModels, legacyGrokInheritManual } from "../manual/model-manual.test.ts";

const profile = { lanes: [], routingPath: null, boardRepos: [], plansDir: null };

function nodeOk(method: string) {
  if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "main", head: "a".repeat(40), gh_repo: "o/r" } };
  if (method === "worktree/create") return { ok: true, result: { path: "/repo/.worktrees/x" } };
  if (method === "git/content-fingerprint") return { ok: true, result: { head: "a".repeat(40), status_digest: "d", content_hash: "h" } };
  return { ok: false, message: method };
}

describe("Astra direction-gate consult", () => {
  it("architect-plan decrements astra budget; budget 0 opens a human gate", async () => {
    const spec = PSTACK_GRAPHS.feature;
    const h = fakeHost({ fetch: typesafeAnswering(0.9), node: nodeOk });
    await createRun(h, {
      run_id: "run-as",
      spec_id: spec.id,
      profile_id: "grok",
      lead_harness: "claude-code",
      task_type: "feature",
      entry: "architect-plan",
      goal: "新增支付功能",
      worktree: "/repo/.worktrees/x",
      astra_budget: 4,
      now: h.now(),
    });
    await advance(h, "run-as", {
      type: "report", phase: "setup",
      outcome: { worker_permission_mode: "bypassPermissions", team_id: "t1" },
      session_id: "s1",
    }, { spec });
    const first = JSON.parse(h.files.get(graphStatePath("run-as"))!) as GraphRunState;
    expect(first.astra_calls).toBe(1);
    expect(first.budget.astra_left).toBe(3);
    expect(first.next?.kind).toBe("dispatch");
    if (first.next?.kind === "dispatch") {
      expect(first.next.subagent?.role ?? first.next.create_worker?.role).toBe("keel-architect");
    }

    const h2 = fakeHost({ fetch: typesafeAnswering(0.9), node: nodeOk });
    await createRun(h2, {
      run_id: "run-out",
      spec_id: spec.id,
      profile_id: "grok",
      lead_harness: "claude-code",
      task_type: "feature",
      entry: "architect-plan",
      goal: "新增支付功能",
      worktree: "/repo/.worktrees/x",
      astra_budget: 0,
      now: h2.now(),
    });
    const empty = await advance(h2, "run-out", {
      type: "report", phase: "setup",
      outcome: { worker_permission_mode: "bypassPermissions", team_id: "t1" },
      session_id: "s1",
    }, { spec });
    expect(empty.next.kind).toBe("decide");
    if (empty.next.kind === "decide") expect(empty.next.gate_id).toBe("human:astra-budget");
  });

  it("investigation still routes G-route low confidence to the lead, not Astra", async () => {
    const h = fakeHost({ fetch: typesafeAnswering(0.2), node: nodeOk });
    const r: any = await runTool(makeContext(h, "c1", profile), "keel_run", {
      goal: "重构登录功能",
      repo_dir: "/repo",
      lead: "claude-code",
      playbook: "investigation",
    });
    expect(r.ok).toBe(true);
    // investigation with explicit playbook starts; no G-route decide.
    expect(r.result.next.kind).not.toBe("decide");
    const st = JSON.parse(h.files.get(graphStatePath(r.result.run_id))!) as GraphRunState;
    expect(st.task_type).toBe("investigation");
  });

  it("a failed report fingerprint repeating twice is visible on the run", async () => {
    const spec = PSTACK_GRAPHS["bug-fix"];
    const h = fakeHost({ node: nodeOk });
    await createRun(h, {
      run_id: "run-fp",
      spec_id: spec.id,
      profile_id: "sol",
      lead_harness: "codex",
      task_type: "bug-fix",
      entry: "reproduce",
      goal: "修登录报错",
      worktree: "/repo/.worktrees/x",
      now: h.now(),
    });
    const key = "run-fp:reproduce:1";
    await withRun(h, "run-fp", (raw) => {
      const s = raw as unknown as GraphRunState;
      s.team = { ready: true, team_id: "t1" };
      s.nodes.reproduce = {
        status: "active", attempts: 1, dispatch_key: key, dispatch_state: "running",
        planned_params: {
          label: "keel-r", role: "keel-worker", agent: "pi", model: "grok-4.6", provider_id: "art-cindy",
          initial_task: "x", writes: true, fallbacks: [], route_index: 0,
        },
      };
    });
    await advance(h, "run-fp", {
      type: "report", phase: "final", dispatch_key: key,
      report: { status: "failed", summary: "boom", ran: [{ cmd: "npx vitest run", exit_code: 1 }], files_changed: [] },
      inline_report: { status: "failed" },
    }, { spec });
    const st = JSON.parse(h.files.get(graphStatePath("run-fp"))!) as GraphRunState;
    expect(st.fingerprints.some((f) => f.signature === "npx vitest run" && f.count >= 1)).toBe(true);
  });
});

function cfg(manual: ModelManual) {
  return { manual, lanes: [], limits: DEFAULT_LIMITS, thresholds: DEFAULT_THRESHOLDS };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function solOf(manual: ModelManual): Mutable<Profile> {
  return manual.profiles.find((p) => p.id === "sol") as Mutable<Profile>;
}

const luna: Route = { agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy", effort: "high" };

async function dispatchNode(entry: string, manual: ModelManual, models: readonly AgentModel[], profile_id = "sol") {
  const spec = PSTACK_GRAPHS.feature;
  const h = fakeHost({ node: nodeOk, agentModels: models });
  await createRun(h, {
    run_id: "run-dir",
    spec_id: spec.id,
    profile_id,
    lead_harness: profile_id === "grok" ? "claude-code" : "codex",
    task_type: "feature",
    entry,
    goal: "新增支付功能",
    worktree: "/repo/.worktrees/x",
    astra_budget: 4,
    now: h.now(),
  });
  const opts = { spec, config: cfg(manual), models };
  const first = await advance(h, "run-dir", { type: "tick" }, opts);
  // 想方案 / 做检查 are Workers, so the first answer is always the team setup.
  expect(first.next.kind).toBe("setup");
  return advance(h, "run-dir", {
    type: "report", phase: "setup",
    outcome: { worker_permission_mode: "bypassPermissions", team_id: "t1" },
    session_id: "s1",
  }, opts);
}

function workerOf(out: Awaited<ReturnType<typeof dispatchNode>>) {
  expect(out.next.kind).toBe("dispatch");
  if (out.next.kind !== "dispatch") throw new Error("dispatch");
  expect(out.next.subagent).toBeUndefined();
  expect(out.next.subagents).toBeUndefined();
  expect(out.next.create_worker).toBeTruthy();
  return out.next.create_worker!;
}

describe("astra-consult direction_route dispatch", () => {
  const models = appendixCAgentModels();

  it("dispatches the explicit direction_route as one Worker and does not fall back when it is unavailable", async () => {
    const manual = cloneManual(DEFAULT_MANUAL);
    solOf(manual).direction_gate = "astra";
    solOf(manual).direction_route = luna;
    const hit = await dispatchNode(ASTRA_CONSULT_ID, manual, models);
    expect(workerOf(hit)).toMatchObject({ role: "keel-architect", agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy", effort: "high" });
    expect(hit.state.astra_calls).toBe(1);
    expect(hit.state.budget.astra_left).toBe(3);

    const missing = cloneManual(manual);
    solOf(missing).direction_route = { ...luna, model: "no-such-model" };
    const stopped = await dispatchNode(ASTRA_CONSULT_ID, missing, models);
    expect(stopped.next.kind).toBe("stop");
    if (stopped.next.kind === "stop") expect(stopped.next.reason).toMatch(/全部路线不可用/);
  });

  it("falls back to the architect slot only when direction_route is omitted, and ignores per-task-type columns", async () => {
    const hit = await dispatchNode(ASTRA_CONSULT_ID, DEFAULT_MANUAL, models);
    expect(workerOf(hit)).toMatchObject({ agent: "claude-code", model: "anthropic/claude-opus-5-5", provider_id: "xd", effort: "xhigh" });

    const tasked = cloneManual(DEFAULT_MANUAL);
    solOf(tasked).nodes = { ...solOf(tasked).nodes, feature: { architect: { primary: luna } } };
    const feat = await dispatchNode(ASTRA_CONSULT_ID, tasked, models);
    expect(workerOf(feat).model).toBe("anthropic/claude-opus-5-5");
  });

  it("does not apply direction_route to architect-plan or astra-final-review", async () => {
    const manual = cloneManual(DEFAULT_MANUAL);
    solOf(manual).direction_route = luna;
    const plan = workerOf(await dispatchNode("architect-plan", manual, models));
    expect(plan).toMatchObject({ role: "keel-architect", agent: "claude-code", model: "anthropic/claude-opus-5-5", effort: "xhigh" });
    expect(plan.model).not.toBe("gpt-6-luna");
    const review = workerOf(await dispatchNode("astra-final-review", manual, models));
    expect(review).toMatchObject({ role: "keel-verifier", agent: "claude-code", model: "anthropic/claude-opus-5-5", effort: "xhigh" });
  });

  it("ignores direction_collaborators: a consult is one Worker and costs one astra point", async () => {
    const manual = cloneManual(DEFAULT_MANUAL);
    solOf(manual).direction_route = luna;
    solOf(manual).direction_collaborators = [{ ...luna, provider_id: "xd", model: "openai/gpt-6-luna" }, { ...luna, effort: "low" }];
    const out = await dispatchNode(ASTRA_CONSULT_ID, { ...manual, version: 2 }, models);
    expect(workerOf(out)).toMatchObject({ model: "gpt-6-luna", effort: "high" });
    expect(out.state.astra_calls).toBe(1);
    expect(out.state.budget.astra_left).toBe(3);
    expect(Object.values(out.state.nodes).every((n) => !n.collaborators?.length)).toBe(true);
  });
});

describe("astra-final-review final_review_route dispatch", () => {
  const models = appendixCAgentModels();

  it("dispatches the Claude Code lead's plan, consult and final review as Codex astra Workers", async () => {
    const plan = workerOf(await dispatchNode("architect-plan", DEFAULT_MANUAL, models, "grok"));
    expect(plan).toMatchObject({ role: "keel-architect", agent: "codex", model: "gpt-6-astra", provider_id: "art-cindy", effort: "xhigh" });
    const review = workerOf(await dispatchNode("astra-final-review", DEFAULT_MANUAL, models, "grok"));
    expect(review).toMatchObject({ role: "keel-verifier", agent: "codex", model: "gpt-6-astra", provider_id: "art-cindy", effort: "xhigh" });
    const consult = workerOf(await dispatchNode(ASTRA_CONSULT_ID, DEFAULT_MANUAL, models, "grok"));
    expect(consult).toMatchObject({ agent: "codex", model: "gpt-6-astra", effort: "xhigh" });
  });

  it("opens a human gate when the explicit route is unavailable and retries the same route", async () => {
    const manual = cloneManual(DEFAULT_MANUAL);
    solOf(manual).final_review_route = luna;
    delete solOf(manual).final_review_fallbacks;
    const missing = models.filter((m) => m.id !== "gpt-6-luna");
    const spec = PSTACK_GRAPHS.feature;
    const h = fakeHost({ node: nodeOk, agentModels: missing });
    await createRun(h, {
      run_id: "run-fr",
      spec_id: spec.id,
      profile_id: "sol",
      lead_harness: "codex",
      task_type: "feature",
      entry: "astra-final-review",
      goal: "新增支付功能",
      worktree: "/repo/.worktrees/x",
      astra_budget: 4,
      now: h.now(),
    });
    const optsMissing = { spec, config: cfg(manual), models: missing };
    await advance(h, "run-fr", { type: "tick" }, optsMissing);
    const gated = await advance(h, "run-fr", {
      type: "report", phase: "setup",
      outcome: { worker_permission_mode: "bypassPermissions", team_id: "t1" },
      session_id: "s1",
    }, optsMissing);
    expect(gated.next.kind).toBe("decide");
    if (gated.next.kind === "decide") {
      expect(gated.next.gate_id).toBe("human:astra-final-review");
      expect(gated.next.options).toEqual(["retry", "stop"]);
    }
    expect(gated.state.status).toBe("waiting_human");
    expect(gated.state.budget.astra_left).toBe(4);
    expect(gated.state.astra_calls).toBe(0);
    expect(Object.values(gated.state.nodes).some((n) => n.dispatch_key)).toBe(false);

    await withRun(h, "run-fr", (raw) => {
      const s = raw as unknown as GraphRunState;
      s.sol_decisions.push({ gate_id: "human:astra-final-review", attempt: 1, answer: "retry" });
    });
    const retried = await advance(h, "run-fr", { type: "tick" }, { spec, config: cfg(manual), models });
    expect(workerOf(retried)).toMatchObject({ agent: "codex", model: "gpt-6-luna", effort: "high" });

    const h2 = fakeHost({ node: nodeOk, agentModels: missing });
    await createRun(h2, {
      run_id: "run-fr-stop",
      spec_id: spec.id,
      profile_id: "sol",
      lead_harness: "codex",
      task_type: "feature",
      entry: "astra-final-review",
      goal: "新增支付功能",
      worktree: "/repo/.worktrees/x",
      astra_budget: 4,
      now: h2.now(),
    });
    await advance(h2, "run-fr-stop", { type: "tick" }, optsMissing);
    await advance(h2, "run-fr-stop", {
      type: "report", phase: "setup",
      outcome: { worker_permission_mode: "bypassPermissions", team_id: "t1" },
      session_id: "s1",
    }, optsMissing);
    await withRun(h2, "run-fr-stop", (raw) => {
      const s = raw as unknown as GraphRunState;
      s.sol_decisions.push({ gate_id: "human:astra-final-review", attempt: 1, answer: "stop" });
    });
    const stopped = await advance(h2, "run-fr-stop", { type: "tick" }, optsMissing);
    expect(stopped.next.kind).toBe("stop");
  });

  it("uses final_review_fallbacks, in order, before opening the human gate", async () => {
    const noOpus = models.filter((m) => m.id !== "anthropic/claude-opus-5-5");
    const viaBackup = await dispatchNode("astra-final-review", DEFAULT_MANUAL, noOpus);
    expect(workerOf(viaBackup)).toMatchObject({ agent: "claude-code", model: "anthropic/claude-sonnet-5-5", provider_id: "xd", effort: "xhigh" });
    if (viaBackup.next.kind === "dispatch") expect(viaBackup.next.note).toMatch(/主路线 anthropic\/claude-opus-5-5 不可用，改用 anthropic\/claude-sonnet-5-5/);

    const noClaude = models.filter((m) => m.agent !== "claude-code");
    const gated = await dispatchNode("astra-final-review", DEFAULT_MANUAL, noClaude);
    expect(gated.next.kind).toBe("decide");
    if (gated.next.kind === "decide") expect(gated.next.gate_id).toBe("human:astra-final-review");

    const noAstraPrimary = models.filter((m) => m.id !== "gpt-6-astra");
    const grokBackup = await dispatchNode("astra-final-review", DEFAULT_MANUAL, noAstraPrimary, "grok");
    expect(workerOf(grokBackup)).toMatchObject({ agent: "codex", model: "openai/gpt-6-astra", provider_id: "xd", effort: "xhigh" });
  });

  it("keeps omitted-field fallback and stop behavior on manuals without final_review_route", async () => {
    const inherited = legacyGrokInheritManual();
    const ok = await dispatchNode("astra-final-review", inherited, models, "grok");
    expect(workerOf(ok)).toMatchObject({ agent: "claude-code", model: "anthropic/claude-opus-5-5" });
    const noOpus = models.filter((m) => m.id !== "anthropic/claude-opus-5-5");
    const stopped = await dispatchNode("astra-final-review", inherited, noOpus, "grok");
    expect(stopped.next.kind).toBe("stop");
    if (stopped.next.kind === "stop") expect(stopped.next.reason).toMatch(/全部路线不可用/);

    const emptyExplicit = cloneManual(DEFAULT_MANUAL);
    solOf(emptyExplicit).final_review_route = luna;
    const empty = await dispatchNode("astra-final-review", emptyExplicit, []);
    expect(empty.next.kind).toBe("decide");
    if (empty.next.kind === "decide") expect(empty.next.gate_id).toBe("human:astra-final-review");

    const omitted = cloneManual(DEFAULT_MANUAL);
    delete solOf(omitted).final_review_route;
    delete solOf(omitted).final_review_fallbacks;
    const emptyOmitted = await dispatchNode("astra-final-review", omitted, []);
    expect(emptyOmitted.next.kind).toBe("stop");
  });
});
