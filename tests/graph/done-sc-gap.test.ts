import { describe, expect, it } from "vitest";
import { isChangeGraphDone } from "../../src/main/graph/done.ts";
import { advance, createRun } from "../../src/main/graph/interpreter.ts";
import { graphStatePath, withRun } from "../../src/main/store/runs.ts";
import { makeContext } from "../../src/main/context.ts";
import { runTool } from "../../src/main/dispatch.ts";
import { mapChangeDoneFailure, runDoneCheck } from "../../src/main/tools/keel.ts";
import type { GraphRunState } from "../../src/main/graph/state.ts";
import { fakeHost } from "../helpers/fakeHost.ts";
import { PSTACK_GRAPHS } from "../../src/shared/graph/pstack.ts";
import { LANE_PRESETS } from "../../src/shared/types.ts";

const profile = { lanes: [], routingPath: null, boardRepos: [], plansDir: null };
const WT = "/repo/.worktrees/x";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const verdict = {
  repo: "o/r",
  pr: 35,
  base_ref: "main",
  base_sha: BASE,
  head_sha: HEAD,
  patch_id: "patch-1",
  level: "unit-test-verified" as const,
  surface: "unit-test" as const,
  by_route: { agent: "pi" as const, model: "grok-4.6", provider_id: "art-cindy" },
  by_family: "grok",
};

function snapshot() {
  return {
    preset: "personal" as const,
    rule: LANE_PRESETS.personal,
    pr: {
      repo: "o/r", number: 35, url: "https://github.com/o/r/pull/35", title: "t", state: "OPEN" as const,
      isDraft: false, headSha: HEAD, headRef: "feat/x", baseRef: "main", mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN", reviewDecision: null, labels: [],
    },
    decision: { kind: "ready" as const },
    checks: { failed: [], pending: [], passed: 1 },
    unresolvedThreads: 0,
    gate: { applies: false, required: [], passed: [], failing: [], pending: [], missing: [], ok: true, sources: [] },
    verification: null,
    mergeReadyLabel: false,
  };
}

function node(method: string, params: { op?: string } = {}) {
  if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "feat/x", head: HEAD, gh_repo: "o/r" } };
  if (method === "git/changed-files") return { ok: true, result: { files: [] } };
  if (method === "pr/resolve") return { ok: true, result: { repo: "o/r", number: 35 } };
  if (method === "pr/snapshot") return { ok: true, result: snapshot() };
  if (method === "pr/threads") return { ok: true, result: { threads: [] } };
  if (method === "git/base-sha") return { ok: true, result: { base_ref: "main", base_sha: BASE } };
  if (method === "git/patch-id") return { ok: true, result: { ok: true, patch_id: "patch-1" } };
  if (method === "orch/run") return { ok: true, result: params.op === "ledger.check" ? { sha: HEAD } : {} };
  return { ok: false, message: method };
}

function read(h: ReturnType<typeof fakeHost>, id: string) {
  return JSON.parse(h.files.get(graphStatePath(id))!) as GraphRunState;
}

async function boot(id: string, graph: "bug-fix" | "pr" = "bug-fix") {
  const h = fakeHost({ node });
  const spec = PSTACK_GRAPHS[graph];
  const ctx = makeContext(h, "c-sc", profile);
  await createRun(h, {
    run_id: id,
    spec_id: spec.id,
    profile_id: "sol",
    lead_harness: "codex",
    task_type: graph,
    entry: "done",
    goal: "修登录报错",
    worktree: WT,
    now: h.now(),
    author_families: ["gpt"],
    sc: [{ id: "SC-1", text: "复现用例转绿" }, { id: "SC-2", text: "回归通过" }],
  });
  await withRun(h, id, (raw) => {
    const s = raw as unknown as GraphRunState;
    s.team = { ready: true, team_id: "t1" };
    s.pr = 35;
    s.repo = "o/r";
    s.gh_repo = "o/r";
    s.author_families = ["gpt"];
    s.pr_binding = { repo: "o/r", number: 35, base_ref: "main", base_sha: BASE, head_sha: HEAD };
    s.nodes.implement = {
      status: "succeeded",
      attempts: 1,
      dispatch_state: "terminal",
      planned_params: {
        writes: true,
        label: "impl",
        role: "keel-worker",
        agent: "pi",
        model: "grok-4.6",
        provider_id: "art-cindy",
        initial_task: "x",
        fallbacks: [],
        route_index: 0,
      },
      actual_route: { agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy" },
    };
    s.nodes["open-pr"] = { status: "succeeded", attempts: 1, dispatch_state: "terminal" };
    s.nodes["wait-ci"] = { status: "succeeded", attempts: 1, dispatch_state: "terminal" };
    s.nodes["astra-final-review"] = {
      status: "succeeded",
      attempts: 1,
      dispatch_state: "terminal",
      report_path: `${WT}/.keel/astra-final-review-1.md`,
      last_report: { status: "done", summary: "pass", verdict: "PASS" },
    };
    s.nodes["verify-head"] = {
      status: "succeeded",
      attempts: 1,
      dispatch_state: "terminal",
      report_path: `${WT}/.keel/verify-head-1.md`,
      last_report: { status: "done", summary: "verified", verdict: "PASS", sc_evidence: { "SC-1": true } },
    };
    s.nodes["report-ready"] = { status: "succeeded", attempts: 1, dispatch_state: "terminal" };
    s.verdict = {
      head: HEAD,
      base_ref: "main",
      base_sha: BASE,
      patch_id: "patch-1",
      value: "unit-test-verified",
      level: "unit-test-verified",
      surface: "unit-test",
      by_family: "grok",
      by_route: verdict.by_route,
    };
    s.budget.astra_left = 3;
  });
  return { h, id, spec, ctx };
}

describe("done gate SC missing evidence", () => {
  it("mapChangeDoneFailure offers revise/waive/stop and keeps wait/stop when SC is present", () => {
    const missing = isChangeGraphDone({
      pr_status: "report_mergeable",
      author_families: ["gpt"],
      verdict,
      current: { head_sha: HEAD, base_sha: BASE, patch_id: "patch-1", patch_ok: true },
      sc: [{ id: "SC-1", hasEvidence: false }, { id: "SC-2", hasEvidence: true }],
      openHumanGates: 0,
    });
    expect(missing.done).toBe(false);
    const next = mapChangeDoneFailure({ run_id: "r1", spec_id: "bug-fix" } as GraphRunState, missing);
    expect(next.kind).toBe("decide");
    if (next.kind !== "decide") throw new Error("decide");
    expect(next.options).toEqual(["revise", "waive", "stop"]);
    expect(next.gate_id).toBe("done");
    expect(next.question).toMatch(/SC-1/);

    const okSc = isChangeGraphDone({
      pr_status: "wait_for_ci",
      author_families: ["gpt"],
      verdict,
      current: { head_sha: HEAD, base_sha: BASE, patch_id: "patch-1", patch_ok: true },
      sc: [{ id: "SC-1", hasEvidence: true }],
      openHumanGates: 0,
    });
    const wait = mapChangeDoneFailure({ run_id: "r1", spec_id: "bug-fix" } as GraphRunState, okSc);
    expect(wait.kind).toBe("decide");
    if (wait.kind !== "decide") throw new Error("decide");
    expect(wait.options).toEqual(["wait", "stop"]);
  });

  it("revise returns to implement with missing SC and verify report in the brief", async () => {
    const { h, id, spec, ctx } = await boot("run-sc-revise");
    const tick = await advance(h, id, { type: "tick" }, { spec, doneCheck: (s) => runDoneCheck(ctx, s) });
    expect(tick.next.kind).toBe("decide");
    if (tick.next.kind !== "decide") throw new Error("decide");
    expect(tick.next.options).toEqual(["revise", "waive", "stop"]);
    const revised: any = await runTool(ctx, "keel_gate", { run_id: id, gate_id: "done", answer: "revise" });
    expect(revised.ok, revised.message).toBe(true);
    expect(revised.result.next.kind).toBe("dispatch");
    expect(revised.result.next.dispatch_key).toBe(`${id}:implement:2`);
    const task = revised.result.next.create_worker?.initial_task ?? "";
    expect(task).toContain("done 门缺证据：SC-2");
    expect(task).toContain(`${WT}/.keel/verify-head-1.md`);
    expect(task).toContain("先读这些已完成报告再动手");
    expect(read(h, id).cursor).toBe("implement");
  });

  it("waive without authorization_source is AUTHORIZATION_REQUIRED", async () => {
    const { h, id, spec, ctx } = await boot("run-sc-waive-noauth");
    const tick = await advance(h, id, { type: "tick" }, { spec, doneCheck: (s) => runDoneCheck(ctx, s) });
    expect(tick.next.kind).toBe("decide");
    const denied: any = await runTool(ctx, "keel_gate", { run_id: id, gate_id: "done", answer: "waive" });
    expect(denied).toMatchObject({ ok: false, errorCode: "AUTHORIZATION_REQUIRED" });
    expect(read(h, id).facts?.waived_sc).toBeUndefined();
  });

  it("waive with user words records the SC and can reach done", async () => {
    const { h, id, spec, ctx } = await boot("run-sc-waive-ok");
    const tick = await advance(h, id, { type: "tick" }, { spec, doneCheck: (s) => runDoneCheck(ctx, s) });
    expect(tick.next.kind).toBe("decide");
    const waived: any = await runTool(ctx, "keel_gate", {
      run_id: id,
      gate_id: "done",
      answer: "waive",
      authorization_source: "用户 2026-10-09：SC-2 这次先不做",
    });
    expect(waived.ok, waived.message).toBe(true);
    expect(read(h, id).facts?.waived_sc).toEqual([
      { id: "SC-2", authorization_source: "用户 2026-10-09：SC-2 这次先不做" },
    ]);
    expect(waived.result.next.kind).toBe("done");
    const ledger = h.files.get(`runs/${id}/decisions.jsonl`) ?? "";
    expect(ledger).toContain("豁免 SC");
    expect(ledger).toContain("用户 2026-10-09：SC-2 这次先不做");
  });

  it("stop ends the run", async () => {
    const { h, id, spec, ctx } = await boot("run-sc-stop");
    const tick = await advance(h, id, { type: "tick" }, { spec, doneCheck: (s) => runDoneCheck(ctx, s) });
    expect(tick.next.kind).toBe("decide");
    const stopped: any = await runTool(ctx, "keel_gate", { run_id: id, gate_id: "done", answer: "stop" });
    expect(stopped.ok, stopped.message).toBe(true);
    expect(stopped.result.next.kind).toBe("stop");
    expect(read(h, id).status).toBe("stopped");
  });

  it("pr graph revise returns to fix-ci:1 with prior reports", async () => {
    const { h, id, spec, ctx } = await boot("run-sc-revise-pr", "pr");
    const tick = await advance(h, id, { type: "tick" }, { spec, doneCheck: (s) => runDoneCheck(ctx, s) });
    expect(tick.next.kind).toBe("decide");
    if (tick.next.kind !== "decide") throw new Error("decide");
    expect(tick.next.context).toMatchObject({ revise_to: "fix-ci" });
    const revised: any = await runTool(ctx, "keel_gate", { run_id: id, gate_id: "done", answer: "revise" });
    expect(revised.ok, revised.message).toBe(true);
    expect(revised.result.next.kind).toBe("dispatch");
    expect(revised.result.next.dispatch_key).toBe(`${id}:fix-ci:1`);
    const task = revised.result.next.create_worker?.initial_task ?? "";
    expect(task).toContain("done 门缺证据：SC-2");
    expect(task).toContain("先读这些已完成报告再动手");
    expect(task).toContain(`${WT}/.keel/verify-head-1.md`);
    expect(task).not.toContain(`${WT}/.keel/open-pr-1.md`);
    expect(read(h, id).cursor).toBe("fix-ci");
  });
});
