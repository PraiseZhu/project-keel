import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../../src/main/config.ts";
import { makeContext } from "../../src/main/context.ts";
import { runTool } from "../../src/main/dispatch.ts";
import { ASTRA_CONSULT_ID, advance, createRun } from "../../src/main/graph/interpreter.ts";
import { graphStatePath, withRun } from "../../src/main/store/runs.ts";
import type { GraphRunState } from "../../src/main/graph/state.ts";
import { PSTACK_GRAPHS } from "../../src/shared/graph/pstack.ts";
import { cloneManual, DEFAULT_MANUAL, type AgentModel, type ModelManual } from "../../src/shared/manual/schema.ts";
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
  if (first.next.kind === "dispatch") return first;
  return advance(h, "run-dir", {
    type: "report", phase: "setup",
    outcome: { worker_permission_mode: "bypassPermissions", team_id: "t1" },
    session_id: "s1",
  }, opts);
}

describe("astra-consult direction_route dispatch", () => {
  const models = appendixCAgentModels();

  it("dispatches the explicit direction_route and does not fall back when it is unavailable", async () => {
    const manual = cloneManual(DEFAULT_MANUAL);
    (manual.profiles[0] as { direction_gate: string; direction_route: { agent: "codex"; model: string; provider_id: string; effort: string } }).direction_gate = "astra";
    (manual.profiles[0] as { direction_route: { agent: "codex"; model: string; provider_id: string; effort: string } }).direction_route = {
      agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy", effort: "high",
    };
    const hit = await dispatchNode(ASTRA_CONSULT_ID, manual, models);
    expect(hit.next.kind).toBe("dispatch");
    if (hit.next.kind === "dispatch") {
      expect(hit.next.create_worker).toMatchObject({ agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy", effort: "high" });
    }

    const missing = cloneManual(manual);
    (missing.profiles[0] as { direction_route: { model: string } }).direction_route.model = "no-such-model";
    const stopped = await dispatchNode(ASTRA_CONSULT_ID, missing, models);
    expect(stopped.next.kind).toBe("stop");
    if (stopped.next.kind === "stop") expect(stopped.next.reason).toMatch(/全部路线不可用/);
  });

  it("falls back to the architect slot only when direction_route is omitted", async () => {
    const hit = await dispatchNode(ASTRA_CONSULT_ID, DEFAULT_MANUAL, models);
    expect(hit.next.kind).toBe("dispatch");
    if (hit.next.kind === "dispatch") {
      expect(hit.next.create_worker).toMatchObject({ agent: "codex", model: "gpt-6-astra", provider_id: "art-cindy", effort: "xhigh" });
    }

    const tasked = cloneManual(DEFAULT_MANUAL);
    (tasked.profiles[0] as { nodes: typeof tasked.profiles[0]["nodes"] }).nodes = {
      ...tasked.profiles[0]!.nodes,
      feature: {
        architect: { primary: { agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy", effort: "medium" } },
      },
    };
    const feat = await dispatchNode(ASTRA_CONSULT_ID, tasked, models);
    expect(feat.next.kind).toBe("dispatch");
    if (feat.next.kind === "dispatch") expect(feat.next.create_worker?.model).toBe("gpt-6-luna");
  });

  it("does not apply direction_route to architect-plan or astra-final-review", async () => {
    const manual = cloneManual(DEFAULT_MANUAL);
    (manual.profiles[0] as { direction_route: { agent: "codex"; model: string; provider_id: string; effort: string } }).direction_route = {
      agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy", effort: "high",
    };
    const plan = await dispatchNode("architect-plan", manual, models);
    expect(plan.next.kind).toBe("dispatch");
    if (plan.next.kind === "dispatch") {
      expect(plan.next.create_worker).toMatchObject({ model: "gpt-6-astra", effort: "xhigh" });
    }
    const review = await dispatchNode("astra-final-review", manual, models);
    expect(review.next.kind).toBe("dispatch");
    if (review.next.kind === "dispatch") {
      expect(review.next.create_worker).toMatchObject({ model: "gpt-6-astra", effort: "xhigh" });
    }
  });
});

describe("astra-final-review final_review_route dispatch", () => {
  const models = appendixCAgentModels();

  it("dispatches Claude plan as Opus and default final review as Astra", async () => {
    const plan = await dispatchNode("architect-plan", DEFAULT_MANUAL, models, "grok");
    expect(plan.next.kind).toBe("dispatch");
    if (plan.next.kind === "dispatch") {
      expect(plan.next.create_worker).toMatchObject({
        agent: "claude-code", model: "anthropic/claude-opus-5-5", provider_id: "xd",
      });
      expect(plan.next.subagent).toBeUndefined();
    }
    const review = await dispatchNode("astra-final-review", DEFAULT_MANUAL, models, "grok");
    expect(review.next.kind).toBe("dispatch");
    if (review.next.kind === "dispatch") {
      expect(review.next.create_worker).toMatchObject({
        agent: "codex", model: "gpt-6-astra", provider_id: "art-cindy", effort: "xhigh",
      });
    }
    const consult = await dispatchNode(ASTRA_CONSULT_ID, DEFAULT_MANUAL, models, "grok");
    expect(consult.next.kind).toBe("dispatch");
    if (consult.next.kind === "dispatch") {
      expect(consult.next.create_worker).toMatchObject({ model: "anthropic/claude-opus-5-5" });
    }
  });

  it("opens a human gate when the explicit route is unavailable and retries the same route", async () => {
    const manual = cloneManual(DEFAULT_MANUAL);
    (manual.profiles[0] as { final_review_route: { agent: "codex"; model: string; provider_id: string; effort: string } }).final_review_route = {
      agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy", effort: "high",
    };
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
    expect(retried.next.kind).toBe("dispatch");
    if (retried.next.kind === "dispatch") {
      expect(retried.next.create_worker).toMatchObject({
        agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy", effort: "high",
      });
    }

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

  it("keeps omitted-field fallback and stop behavior on old manuals", async () => {
    const inherited = legacyGrokInheritManual();
    const noPrimary = models.filter((m) => m.id !== "gpt-6-astra");
    const fallback = await dispatchNode("astra-final-review", inherited, noPrimary, "grok");
    expect(fallback.next.kind).toBe("dispatch");
    if (fallback.next.kind === "dispatch") {
      expect(fallback.next.create_worker).toMatchObject({ model: "openai/gpt-6-astra", provider_id: "xd" });
    }
    const none = models.filter((m) => !m.id.includes("astra"));
    const stopped = await dispatchNode("astra-final-review", inherited, none, "grok");
    expect(stopped.next.kind).toBe("stop");
    const emptyExplicit = cloneManual(DEFAULT_MANUAL);
    (emptyExplicit.profiles[0] as { final_review_route: { agent: "codex"; model: string; provider_id: string; effort: string } }).final_review_route = {
      agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy", effort: "high",
    };
    const empty = await dispatchNode("astra-final-review", emptyExplicit, []);
    expect(empty.next.kind).toBe("decide");
    if (empty.next.kind === "decide") expect(empty.next.gate_id).toBe("human:astra-final-review");
    const emptyOmitted = await dispatchNode("astra-final-review", DEFAULT_MANUAL, []);
    expect(emptyOmitted.next.kind).toBe("stop");
  });
});
