import { describe, expect, it } from "vitest";
import { isChangeGraphDone } from "../../src/main/graph/done.ts";
import { GATES } from "../../src/main/graph/gates.ts";
import { advance, createRun } from "../../src/main/graph/interpreter.ts";
import { graphStatePath, withRun } from "../../src/main/store/runs.ts";
import { makeContext } from "../../src/main/context.ts";
import { runTool } from "../../src/main/dispatch.ts";
import { runGate } from "../../src/main/jev/gates.ts";
import {
  advanceEvidenceForNode,
  authorFamiliesFromRoutes,
  mapChangeDoneFailure,
  runDoneCheck,
  waitOnFromFacts,
} from "../../src/main/tools/keel.ts";
import type { GraphRunState } from "../../src/main/graph/state.ts";
import { fakeHost } from "../helpers/fakeHost.ts";
import { PSTACK_GRAPHS } from "../../src/shared/graph/pstack.ts";
import type { GraphSpec } from "../../src/shared/graph/spec.ts";
import { LANE_PRESETS } from "../../src/shared/types.ts";

const profile = { lanes: [], routingPath: null, boardRepos: [], plansDir: null };
const verdict = {
  repo: "o/r",
  pr: 1,
  base_ref: "main",
  base_sha: "b".repeat(40),
  head_sha: "a".repeat(40),
  patch_id: "patch-1",
  level: "unit-test-verified" as const,
  surface: "unit-test" as const,
  by_route: { agent: "pi" as const, model: "grok-4.6", provider_id: "art-cindy" },
  by_family: "grok",
};

function current(over: Partial<{ head_sha: string; base_sha: string; patch_id: string | null; patch_ok: boolean }> = {}) {
  return { head_sha: verdict.head_sha, base_sha: verdict.base_sha, patch_id: "patch-1", patch_ok: true, ...over };
}

describe("P1-1 change graph cannot false-complete", () => {
  it("blocks done without verdict, with same-family verifier, with a different patch_id, or while waiting on CI", () => {
    const base = {
      author_families: ["grok"],
      verdict,
      current: current(),
      sc: [{ id: "SC-1", hasEvidence: true }],
      openHumanGates: 0,
      pr_status: "report_mergeable",
    };
    expect(isChangeGraphDone({ ...base, verdict: null }).done).toBe(false);
    expect(isChangeGraphDone({ ...base, author_families: ["grok"], verdict: { ...verdict, by_family: "grok" } }).done).toBe(false);
    expect(isChangeGraphDone({ ...base, current: current({ patch_id: "other" }) }).done).toBe(false);
    expect(isChangeGraphDone({ ...base, pr_status: "wait_for_ci" }).done).toBe(false);
    const state = { run_id: "r1", spec_id: "bug-fix", cursor: "done", nodes: {}, status: "running" } as GraphRunState;
    for (const input of [
      { ...base, verdict: null },
      { ...base, current: current({ patch_id: "other" }) },
      { ...base, pr_status: "wait_for_ci" },
    ]) {
      const next = mapChangeDoneFailure(state, isChangeGraphDone(input));
      expect(next.kind).not.toBe("done");
    }
  });
  it("authorFamiliesFromRoutes only uses actual write-node routes", () => {
    const empty = authorFamiliesFromRoutes({ nodes: { implement: { planned_params: { writes: true, model: "x" } } } } as unknown as GraphRunState);
    expect(empty).toEqual([]);
    const got = authorFamiliesFromRoutes({
      nodes: {
        implement: { planned_params: { writes: true }, actual_route: { model: "grok-4.6" } },
        explore: { planned_params: { writes: false }, actual_route: { model: "gpt-6.1-sol" } },
      },
    } as unknown as GraphRunState);
    expect(got).toEqual(["grok"]);
  });
});

describe("done gate retries verify when the verdict level is too low", () => {
  it("matching head/patch with type-check-only offers retry_verify and re-dispatches the verifier", async () => {
    const low = isChangeGraphDone({
      pr_status: "report_mergeable",
      author_families: ["gpt"],
      verdict: { ...verdict, level: "type-check-only" },
      current: current(),
      sc: [{ id: "SC-1", hasEvidence: true }],
      openHumanGates: 0,
    });
    expect(low.done).toBe(false);
    expect(low.next).toBe("verify-head");

    const h = fakeHost({
      node: (method: string) => {
        if (method === "git/changed-files") return { ok: true, result: { files: [] } };
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "f", head: verdict.head_sha } };
        if (method === "worktree/create") return { ok: true, result: { path: "/repo/.worktrees/x" } };
        return { ok: false, message: method };
      },
    });
    const spec = PSTACK_GRAPHS["bug-fix"];
    await createRun(h, {
      run_id: "run-level",
      spec_id: spec.id,
      profile_id: "sol",
      lead_harness: "codex",
      task_type: "bug-fix",
      entry: "done",
      goal: "修登录报错",
      worktree: "/repo/.worktrees/x",
      now: h.now(),
    });
    await withRun(h, "run-level", (raw) => {
      const s = raw as unknown as GraphRunState;
      s.cursor = "done";
      s.team = { ready: true, team_id: "t1" };
      s.nodes["verify-head"] = { status: "succeeded", attempts: 1, dispatch_state: "terminal" };
      const mapped = mapChangeDoneFailure(s, low);
      s.next = mapped;
      s.status = mapped.kind === "decide" && mapped.gate_id.startsWith("human:") ? "waiting_human" : s.status;
    });
    const st = JSON.parse(h.files.get(graphStatePath("run-level"))!) as GraphRunState;
    expect(st.next?.kind).toBe("decide");
    if (st.next?.kind !== "decide") throw new Error("decide");
    expect(st.next.options).toEqual(["retry_verify", "stop"]);
    expect(st.next.gate_id).toBe("human:verify-head");
    expect(st.cursor).toBe("verify-head");

    const r: any = await runTool(makeContext(h, "c1", profile), "keel_gate", {
      run_id: "run-level",
      gate_id: "human:verify-head",
      answer: "retry_verify",
    });
    expect(r.ok, r.message).toBe(true);
    expect(r.result.next.kind).toBe("dispatch");
    expect(r.result.next.dispatch_key).toBe("run-level:verify-head:2");
    expect(JSON.parse(h.files.get(graphStatePath("run-level"))!).cursor).toBe("verify-head");
    expect(JSON.parse(h.files.get(graphStatePath("run-level"))!).nodes["verify-head"]?.attempts).toBe(2);
  });
});

describe("P1-2 gates use evidence and runGate", () => {
  it("G-advance with exit_code 1 stays without asking the lead", async () => {
    const ev = advanceEvidenceForNode({
      nodeId: "verify-same-surface",
      ran: [{ cmd: "npm test", exit_code: 1 }],
      head_matches: true,
      new_report: true,
    });
    expect(GATES["G-advance"].deterministic(ev)).toBe("stay");
    const ctx = makeContext(fakeHost(), "c1", profile);
    const r = await runGate(ctx, "G-advance", ev, {
      run_id: "r1",
      jev: async () => ({ choice: "advance", confidence: 0.99 }),
    });
    expect(r).toMatchObject({ deterministic: "stay", routed: "act", value: "stay" });
  });
  it("a consumed keel_gate answer is not reused on the next pass", async () => {
    const h = fakeHost();
    const spec = PSTACK_GRAPHS["bug-fix"];
    await createRun(h, {
      run_id: "run-gate",
      spec_id: spec.id,
      profile_id: "sol",
      lead_harness: "codex",
      task_type: "bug-fix",
      entry: "g-advance-mechanism",
      goal: "fix",
      now: h.now(),
    });
    const path = graphStatePath("run-gate");
    const first = await runTool(makeContext(h, "c1", profile), "keel_gate", {
      run_id: "run-gate", gate_id: "g-advance-mechanism", answer: "advance",
    });
    expect((first as { ok: boolean }).ok).toBe(true);
    const after = JSON.parse(h.files.get(path)!) as GraphRunState;
    expect(after.sol_decisions.filter((d) => d.gate_id === "g-advance-mechanism" && d.attempt === 1)).toEqual([]);
    after.cursor = "g-advance-mechanism";
    after.status = "running";
    after.next = undefined;
    after.nodes["g-advance-mechanism"] = { status: "pending", attempts: 2 };
    after.nodes["research"] = {
      status: "succeeded",
      attempts: 1,
      ended_at: 2,
      last_report: { ran: [{ cmd: "npm test", exit_code: 1 }], fresh: true, head_matches: true, files_changed: [] },
    };
    h.files.set(path, JSON.stringify(after));
    const second = await advance(h, "run-gate", { type: "tick" }, {
      spec,
      gates: {
        advance: async ({ state: s }) => {
          const leftover = s.sol_decisions.find((d) => d.gate_id === "g-advance-mechanism");
          expect(leftover).toBeUndefined();
          const ev = advanceEvidenceForNode({
            nodeId: "verify-same-surface",
            ran: [{ cmd: "npm test", exit_code: 1 }],
            head_matches: true,
            new_report: true,
          });
          return GATES["G-advance"].deterministic(ev) === "stay" ? "stay" : undefined;
        },
      },
    });
    expect(second.next.kind).not.toBe("done");
    if (second.next.kind === "decide") expect(second.next.gate_id).not.toBe("g-advance-mechanism");
  });
});

function snap(kind: "waiting" | "ci_red") {
  return {
    ok: true,
    result: {
      preset: "personal",
      rule: LANE_PRESETS.personal,
      pr: {
        repo: "o/r", number: 1, url: "https://github.com/o/r/pull/1", title: "t", state: "OPEN",
        isDraft: false, headSha: "abc", headRef: "f", baseRef: "main", mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN", reviewDecision: null, labels: [],
      },
      decision: kind === "ci_red" ? { kind: "blocker", blocker: "failing-checks" } : { kind: "waiting" },
      checks: { failed: kind === "ci_red" ? ["ci"] : [], pending: kind === "waiting" ? ["ci"] : [], passed: 0 },
      unresolvedThreads: 0,
      gate: { applies: false, required: [], passed: [], failing: [], pending: [], missing: [], ok: true, sources: [] },
      verification: null,
      mergeReadyLabel: false,
    },
  };
}

describe("P1-3 keel_wait follows CI edges and times out as wait", () => {
  it("maps CI failure to ci_red", () => {
    expect(waitOnFromFacts({ nextAction: "classify_ci_failure" } as never)).toBe("ci_red");
    expect(waitOnFromFacts({ nextAction: "wait_for_ci" } as never)).toBe("wait");
  });
  it("CI red advances wait_done on ci_red; timeout keeps next.kind wait", async () => {
    const hRed = fakeHost({
      node: (method: string) => {
        if (method === "pr/snapshot") return snap("ci_red");
        if (method === "pr/threads") return { ok: true, result: { threads: [] } };
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "f", head: "abc" } };
        if (method === "worktree/create") return { ok: true, result: { path: "/repo/.worktrees/x" } };
        return { ok: false, message: method };
      },
    });
    const started: any = await runTool(makeContext(hRed, "c1", profile), "keel_run", {
      goal: "盯一下 PR", repo_dir: "/repo", scope: ["src/**", "tests/**"], lead: "codex", pr: 1, playbook: "pr",
    });
    expect(started.ok).toBe(true);
    const path = [...hRed.files.keys()].find((k) => k.endsWith("graph-state.json"))!;
    const st = JSON.parse(hRed.files.get(path)!) as GraphRunState;
    st.cursor = "wait-ci";
    st.pr = 1;
    st.repo = "o/r";
    st.next = { kind: "wait", call: { tool: "keel_wait", args: { run_id: st.run_id } } };
    hRed.files.set(path, JSON.stringify(st));
    const red: any = await runTool(makeContext(hRed, "c2", profile), "keel_wait", { run_id: st.run_id, max_minutes: 1 });
    expect(red.ok).toBe(true);

    const hWait = fakeHost({
      node: (method: string) => {
        if (method === "pr/snapshot") return snap("waiting");
        if (method === "pr/threads") return { ok: true, result: { threads: [] } };
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "f", head: "abc" } };
        if (method === "worktree/create") return { ok: true, result: { path: "/repo/.worktrees/x" } };
        return { ok: false, message: method };
      },
    });
    const s2: any = await runTool(makeContext(hWait, "c1", profile), "keel_run", {
      goal: "盯一下 PR", repo_dir: "/repo", scope: ["src/**", "tests/**"], lead: "codex", pr: 1, playbook: "pr",
    });
    const p2 = [...hWait.files.keys()].find((k) => k.endsWith("graph-state.json"))!;
    const st2 = JSON.parse(hWait.files.get(p2)!) as GraphRunState;
    st2.cursor = "wait-ci";
    st2.pr = 1;
    st2.repo = "o/r";
    st2.next = { kind: "wait", call: { tool: "keel_wait", args: { run_id: st2.run_id } } };
    hWait.files.set(p2, JSON.stringify(st2));
    hWait.clock.t += 14 * 60 * 1000;
    const timed: any = await runTool(makeContext(hWait, "c2", profile), "keel_wait", { run_id: st2.run_id, max_minutes: 1 });
    expect(timed.ok).toBe(true);
    expect(timed.result.next.kind).toBe("wait");
  });
});

describe("P1-4 investigation citation comes from the report", () => {
  it("a report without citation is not done and does not throw SCOPE_VIOLATION", async () => {
    const h = fakeHost({
      node: (method: string) => {
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "main", head: "abc" } };
        if (method === "git/content-fingerprint") return { ok: true, result: { head: "abc", status_digest: "d", content_hash: "h" } };
        return { ok: false, message: method };
      },
    });
    const started: any = await runTool(makeContext(h, "c1", profile), "keel_run", {
      goal: "调查超时原理", repo_dir: "/repo", scope: ["src/**", "tests/**"], lead: "codex", playbook: "investigation",
    });
    expect(started.ok).toBe(true);
    const path = [...h.files.keys()].find((k) => k.endsWith("graph-state.json"))!;
    const st = JSON.parse(h.files.get(path)!) as GraphRunState;
    st.cursor = "done";
    st.team = { ready: true };
    st.nodes["report"] = {
      status: "succeeded",
      attempts: 1,
      last_report: { status: "done", summary: "ok", fresh: true },
    };
    h.files.set(path, JSON.stringify(st));
    const r: any = await runTool(makeContext(h, "c2", profile), "keel_status", { run_id: st.run_id });
    expect(r.ok).toBe(true);
    const tick: any = await runTool(makeContext(h, "c3", profile), "keel_gate", {
      run_id: st.run_id, gate_id: "unused", answer: "x",
    });
    expect(tick.ok).toBe(true);
    expect(tick.result.next.kind).not.toBe("done");
    expect(tick.errorCode).not.toBe("SCOPE_VIOLATION");
    if (tick.result.next.kind === "decide") {
      expect(JSON.stringify(tick.result.next.context?.missing ?? tick.result.next.question)).toMatch(/引用|未完成/);
    }
  });
});

describe("P1-5 write scope is not caller-supplied **", () => {
  it("rejects writes when planned_params has no scope, even if the caller passes **", async () => {
    const h = fakeHost({
      node: (method: string) => {
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "f", head: "abc" } };
        if (method === "worktree/create") return { ok: true, result: { path: "/repo/.worktrees/x" } };
        if (method === "git/changed-files") return { ok: true, result: { files: ["docs/a.md"] } };
        return { ok: false, message: method };
      },
    });
    const started: any = await runTool(makeContext(h, "c1", profile), "keel_run", {
      goal: "修登录报错", repo_dir: "/repo", scope: ["src/**", "tests/**"], lead: "codex",
    });
    const st0 = JSON.parse(h.files.get([...h.files.keys()].find((k) => k.endsWith("graph-state.json"))!)!) as GraphRunState;
    const runId = st0.run_id;
    const key = `${runId}:implement:1`;
    const planned = {
      label: "keel-impl-1",
      role: "keel-worker" as const,
      agent: "pi" as const,
      model: "grok-4.6",
      provider_id: "art-cindy",
      initial_task: "x",
      writes: true,
      fallbacks: [] as const,
      route_index: 0,
    };
    await withRun(h, runId, (raw) => {
      const s = raw as unknown as GraphRunState;
      s.nodes.implement = {
        status: "active",
        attempts: 1,
        dispatch_key: key,
        dispatch_state: "running",
        planned_params: { ...planned },
      };
    });
    const noScope: any = await runTool(makeContext(h, "c2", profile), "keel_report", {
      run_id: runId,
      phase: "final",
      dispatch_key: key,
      scope: ["**"],
      inline_report: { status: "done", summary: "ok", files_changed: ["docs/a.md"], ran: [{ cmd: "npm test", exit_code: 0 }] },
    });
    expect(noScope).toMatchObject({ ok: false, errorCode: "SCOPE_VIOLATION" });

    await withRun(h, runId, (raw) => {
      const s = raw as unknown as GraphRunState;
      if (s.nodes.implement?.planned_params) s.nodes.implement.planned_params.scopeAllow = ["src/**"];
    });
    const outside: any = await runTool(makeContext(h, "c3", profile), "keel_report", {
      run_id: runId,
      phase: "final",
      dispatch_key: key,
      scope: ["**"],
      inline_report: { status: "done", summary: "ok", files_changed: ["docs/a.md"], ran: [{ cmd: "npm test", exit_code: 0 }] },
    });
    expect(outside).toMatchObject({ ok: false, errorCode: "SCOPE_VIOLATION" });
    expect(outside.message).toMatch(/docs\/a.md|写域/);
  });
});

describe("done uses the PR head, not an unpushed local head", () => {
  function hostWith(prHead: string, localHead: string) {
    const snapshot = {
      preset: "personal" as const,
      rule: LANE_PRESETS.personal,
      pr: { repo: "o/r", number: 1, url: "u", title: "t", state: "OPEN" as const, isDraft: false, headSha: prHead, headRef: "f", baseRef: "main", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, labels: [] },
      decision: { kind: "ready" as const },
      checks: { failed: [], pending: [], passed: 1 },
      unresolvedThreads: 0,
      gate: { applies: false, required: [], passed: [], failing: [], pending: [], missing: [], ok: true, sources: [] },
      verification: null,
      mergeReadyLabel: false,
      rendered: "x",
    };
    return fakeHost({
      node: (method, params: any) => {
        if (method === "pr/snapshot") return { ok: true, result: snapshot };
        if (method === "pr/threads") return { ok: true, result: { threads: [] } };
        if (method === "git/state") return { ok: true, result: { head: localHead } };
        if (method === "git/base-sha") return { ok: true, result: { base_ref: "main", base_sha: verdict.base_sha } };
        if (method === "git/patch-id") return { ok: true, result: { ok: true, patch_id: "patch-1" } };
        if (method === "orch/run") {
          if (params.op === "init") return { ok: true, result: { store: params.store } };
          if (params.op === "ledger.check") return { ok: true, result: { pr: "1", sha: prHead, verdict: "unit-test-verified" } };
          return { ok: true, result: {} };
        }
        return { ok: false, message: method };
      },
    });
  }
  const state = {
    run_id: "r1",
    task_type: "bug-fix",
    spec_id: "bug-fix",
    repo: "o/r",
    pr: 1,
    worktree: "/repo/wt",
    sc: [],
    status: "running",
    nodes: { implement: { attempts: 1, planned_params: { writes: true }, actual_route: { model: "gpt-6-luna" } } },
    verdict: { head: verdict.head_sha, base_sha: verdict.base_sha, base_ref: "main", patch_id: "patch-1", level: "unit-test-verified", surface: "unit-test", by_route: verdict.by_route, by_family: "grok" },
  } as unknown as GraphRunState;

  it("a verified local commit that is not pushed is not done", async () => {
    const h = hostWith("c".repeat(40), verdict.head_sha);
    const r = await runDoneCheck(makeContext(h, "c1"), structuredClone(state));
    expect(r.ok).toBe(false);
  });

  it("the same verified head locally and on the PR is done", async () => {
    const h = hostWith(verdict.head_sha, verdict.head_sha);
    const r = await runDoneCheck(makeContext(h, "c1"), structuredClone(state));
    expect(r.ok).toBe(true);
  });
});

describe("retry_verify rewinds verify-head without burning attempts", () => {
  const head = verdict.head_sha;
  const base = verdict.base_sha;
  const wt = "/repo/.worktrees/x";
  const snapshot = {
    preset: "personal" as const,
    rule: LANE_PRESETS.personal,
    pr: {
      repo: "o/r", number: 35, url: "https://github.com/o/r/pull/35", title: "t", state: "OPEN" as const,
      isDraft: false, headSha: head, headRef: "feat/x", baseRef: "main", mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN", reviewDecision: null, labels: [],
    },
    decision: { kind: "ready" as const },
    checks: { failed: [], pending: [], passed: 1 },
    unresolvedThreads: 0,
    gate: { applies: false, required: [], passed: [], failing: [], pending: [], missing: [], ok: true, sources: [] },
    verification: null,
    mergeReadyLabel: false,
  };

  function node(method: string, params: any) {
    if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "feat/x", head, gh_repo: "o/r" } };
    if (method === "git/changed-files") return { ok: true, result: { files: [] } };
    if (method === "pr/resolve") return { ok: true, result: { repo: "o/r", number: 35 } };
    if (method === "pr/snapshot") return { ok: true, result: snapshot };
    if (method === "pr/threads") return { ok: true, result: { threads: [] } };
    if (method === "git/base-sha") return { ok: true, result: { base_ref: "main", base_sha: base } };
    if (method === "git/patch-id") return { ok: true, result: { ok: true, patch_id: "patch-1" } };
    if (method === "orch/run") return { ok: true, result: params.op === "ledger.check" ? { sha: head } : {} };
    return { ok: false, message: method };
  }

  function read(h: ReturnType<typeof fakeHost>, id: string) {
    return JSON.parse(h.files.get(graphStatePath(id))!) as GraphRunState;
  }

  async function boot(
    graph: "bug-fix" | "feature" | "refactoring" | "pr",
    attempts: number,
    afterRevision = false,
    designContested = false,
  ) {
    const h = fakeHost({ node });
    const id = `retry-${graph}-${attempts}-${afterRevision ? "rev" : "n"}-${designContested ? "c" : "u"}`;
    const spec = PSTACK_GRAPHS[graph];
    const ctx = makeContext(h, "c-retry", profile);
    await createRun(h, {
      run_id: id,
      spec_id: spec.id,
      profile_id: "sol",
      lead_harness: "codex",
      task_type: graph,
      entry: "done",
      goal: "retry verification",
      worktree: wt,
      now: h.now(),
      author_families: ["grok"],
      sc: [{ id: "SC-1", text: "tests pass" }],
    });
    await withRun(h, id, (raw) => {
      const s = raw as unknown as GraphRunState;
      s.team = { ready: true, team_id: "t1" };
      s.pr = 35;
      s.repo = "o/r";
      s.gh_repo = "o/r";
      s.author_families = ["grok"];
      s.pr_binding = { repo: "o/r", number: 35, base_ref: "main", base_sha: base, head_sha: head };
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
        actual_route: { agent: "pi", model: "grok-4.6", provider_id: "art-cindy" },
      };
      for (const name of ["open-pr", "wait-ci", "astra-final-review"] as const) {
        s.nodes[name] = { status: "succeeded", attempts: afterRevision ? 2 : 1, dispatch_state: "terminal" };
      }
      s.nodes["report-ready"] = { status: "succeeded", attempts, dispatch_state: "terminal" };
      s.nodes["astra-final-review"]!.last_report = { status: "done", summary: "pass", verdict: "PASS" };
      s.nodes["verify-head"] = {
        status: "succeeded",
        attempts,
        dispatch_state: "terminal",
        last_report: { status: "done", summary: "aggregate passed", verdict: "PASS", sc_evidence: { "SC-1": true } },
      };
      s.verdict = {
        head,
        base_ref: "main",
        base_sha: base,
        patch_id: "patch-1",
        value: "type-check-only",
        level: "type-check-only",
        surface: "type-check",
        by_family: "gpt",
        by_route: { agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy" },
      };
      s.facts = { design_contested: designContested };
      s.budget.astra_left = 3;
    });
    return { h, id, spec, ctx };
  }

  it.each(["bug-fix", "feature", "refactoring", "pr"] as const)(
    "%s low-level rewind offers retry_verify on human:verify-head",
    async (graph) => {
      const { h, id, spec, ctx } = await boot(graph, 1);
      const initial = await advance(h, id, { type: "tick" }, { spec, doneCheck: (s) => runDoneCheck(ctx, s) });
      expect(initial.next.kind).toBe("decide");
      if (initial.next.kind !== "decide") throw new Error("decide");
      expect(initial.next.gate_id).toBe("human:verify-head");
      expect(initial.next.options).toEqual(["retry_verify", "stop"]);
      expect(read(h, id).cursor).toBe("verify-head");
      expect(read(h, id).nodes["verify-head"]?.attempts).toBe(1);
    },
  );

  it("attempt 1 re-dispatches verify-head:2 and attempt 2 re-dispatches :3", async () => {
    const first = await boot("bug-fix", 1);
    const firstTick = await advance(first.h, first.id, { type: "tick" }, { spec: first.spec, doneCheck: (s) => runDoneCheck(first.ctx, s) });
    expect(firstTick.next.kind).toBe("decide");
    if (firstTick.next.kind !== "decide") throw new Error("decide");
    const firstRetry: any = await runTool(first.ctx, "keel_gate", {
      run_id: first.id, gate_id: firstTick.next.gate_id, answer: "retry_verify",
    });
    expect(firstRetry.ok, firstRetry.message).toBe(true);
    expect(firstRetry.result.next.kind).toBe("dispatch");
    expect(firstRetry.result.next.dispatch_key).toBe(`${first.id}:verify-head:2`);
    expect(read(first.h, first.id).nodes["verify-head"]?.attempts).toBe(2);

    const second = await boot("bug-fix", 2);
    const secondTick = await advance(second.h, second.id, { type: "tick" }, { spec: second.spec, doneCheck: (s) => runDoneCheck(second.ctx, s) });
    expect(secondTick.next.kind).toBe("decide");
    if (secondTick.next.kind !== "decide") throw new Error("decide");
    const secondRetry: any = await runTool(second.ctx, "keel_gate", {
      run_id: second.id, gate_id: secondTick.next.gate_id, answer: "retry_verify",
    });
    expect(secondRetry.ok, secondRetry.message).toBe(true);
    expect(secondRetry.result.next.kind).toBe("dispatch");
    expect(secondRetry.result.next.dispatch_key).toBe(`${second.id}:verify-head:3`);
    expect(read(second.h, second.id).nodes["verify-head"]?.attempts).toBe(3);
  });

  it("attempt 3 stays stopped instead of dispatching a fourth verify", async () => {
    const { h, id, spec, ctx } = await boot("bug-fix", 3);
    const initial = await advance(h, id, { type: "tick" }, { spec, doneCheck: (s) => runDoneCheck(ctx, s) });
    expect(initial.next.kind).toBe("decide");
    if (initial.next.kind !== "decide") throw new Error("decide");
    const retry: any = await runTool(ctx, "keel_gate", {
      run_id: id, gate_id: initial.next.gate_id, answer: "retry_verify",
    });
    expect(retry.ok, retry.message).toBe(true);
    expect(retry.result.next.kind).toBe("decide");
    expect(retry.result.next.options).toEqual(["stop"]);
    expect(retry.result.next.question).toMatch(/verify-head/);
    expect(read(h, id).nodes["verify-head"]?.attempts).toBe(3);
  });

  it.each([false, true] as const)(
    "feature retry_verify does not consume open-pr after two final reviews when design_contested=%s",
    async (designContested) => {
      const { h, id, spec, ctx } = await boot("feature", 1, true, designContested);
      const initial = await advance(h, id, { type: "tick" }, { spec, doneCheck: (s) => runDoneCheck(ctx, s) });
      expect(initial.next.kind).toBe("decide");
      if (initial.next.kind !== "decide") throw new Error("decide");
      expect(initial.next.gate_id).toBe("human:verify-head");
      const retry: any = await runTool(ctx, "keel_gate", {
        run_id: id, gate_id: initial.next.gate_id, answer: "retry_verify",
      });
      expect(retry.ok, retry.message).toBe(true);
      expect(retry.result.next.kind).toBe("dispatch");
      expect(retry.result.next.dispatch_key).toBe(`${id}:verify-head:2`);
      const st = read(h, id);
      expect(st.cursor).toBe("verify-head");
      expect(st.nodes["verify-head"]?.attempts).toBe(2);
      expect(st.nodes["open-pr"]?.attempts).toBe(2);
      expect(st.nodes["wait-ci"]?.attempts).toBe(2);
      expect(st.nodes["astra-final-review"]?.attempts).toBe(2);
      expect(st.nodes.interrogate?.status).not.toBe("active");
    },
  );

  it("a passing npm test re-verify reaches done", async () => {
    const { h, id, spec, ctx } = await boot("bug-fix", 1);
    const initial = await advance(h, id, { type: "tick" }, { spec, doneCheck: (s) => runDoneCheck(ctx, s) });
    expect(initial.next.kind).toBe("decide");
    if (initial.next.kind !== "decide") throw new Error("decide");
    const retry: any = await runTool(ctx, "keel_gate", {
      run_id: id, gate_id: initial.next.gate_id, answer: "retry_verify",
    });
    expect(retry.ok, retry.message).toBe(true);
    expect(retry.result.next.kind).toBe("dispatch");
    const key = retry.result.next.dispatch_key as string;
    expect(key).toBe(`${id}:verify-head:2`);
    const accepted: any = await runTool(ctx, "keel_report", {
      run_id: id,
      phase: "accepted",
      dispatch_key: key,
      worker_id: "audit-verifier",
      worker_session_id: "audit-session",
      dispatch_outcome: { dispatched: true },
    });
    expect(accepted.ok, accepted.message).toBe(true);
    const report: any = await runTool(ctx, "keel_report", {
      run_id: id,
      phase: "final",
      dispatch_key: key,
      inline_report: {
        status: "done",
        summary: "tests pass",
        head_sha: head,
        files_changed: [],
        functions_touched: [],
        changed_lines: 0,
        ran: [{ cmd: "npm test", exit_code: 0, tests_passed: 642 }],
        sc_evidence: { "SC-1": true },
        verdict: "PASS",
      },
    });
    expect(report.ok, report.message).toBe(true);
    expect(read(h, id).verdict?.level).toBe("unit-test-verified");
    expect(read(h, id).cursor).toBe("report-ready");
    const done: any = await runTool(ctx, "keel_wait", { run_id: id });
    expect(done.ok, done.message).toBe(true);
    expect(done.result.next.kind).toBe("done");
  });

  async function retryVerifyReport(
    h: ReturnType<typeof fakeHost>,
    id: string,
    spec: GraphSpec,
    ctx: ReturnType<typeof makeContext>,
    ran: { cmd: string; exit_code: number; tests_passed: number }[],
  ) {
    const tick = await advance(h, id, { type: "tick" }, { spec, doneCheck: (s) => runDoneCheck(ctx, s) });
    expect(tick.next.kind).toBe("decide");
    if (tick.next.kind !== "decide") throw new Error("decide");
    expect(tick.next.gate_id).toBe("human:verify-head");
    const retry: any = await runTool(ctx, "keel_gate", {
      run_id: id, gate_id: tick.next.gate_id, answer: "retry_verify",
    });
    expect(retry.ok, retry.message).toBe(true);
    expect(retry.result.next.kind).toBe("dispatch");
    const key = retry.result.next.dispatch_key as string;
    const accepted: any = await runTool(ctx, "keel_report", {
      run_id: id,
      phase: "accepted",
      dispatch_key: key,
      worker_id: "audit-verifier",
      worker_session_id: "audit-session",
      dispatch_outcome: { dispatched: true },
    });
    expect(accepted.ok, accepted.message).toBe(true);
    const report: any = await runTool(ctx, "keel_report", {
      run_id: id,
      phase: "final",
      dispatch_key: key,
      inline_report: {
        status: "done",
        summary: "re-verify",
        head_sha: head,
        files_changed: [],
        functions_touched: [],
        changed_lines: 0,
        ran,
        sc_evidence: { "SC-1": true },
        verdict: "PASS",
      },
    });
    expect(report.ok, report.message).toBe(true);
    return key;
  }

  it("attempt 2 still-low then attempt 3 npm test reaches done", async () => {
    const { h, id, spec, ctx } = await boot("bug-fix", 1);
    const key2 = await retryVerifyReport(h, id, spec, ctx, [{ cmd: "npm run verify", exit_code: 0, tests_passed: 0 }]);
    expect(key2).toBe(`${id}:verify-head:2`);
    expect(read(h, id).verdict?.level).toBe("type-check-only");
    const mid: any = await runTool(ctx, "keel_wait", { run_id: id });
    expect(mid.ok, mid.message).toBe(true);
    expect(mid.result.next.kind).toBe("decide");
    expect(mid.result.next.gate_id).toBe("human:verify-head");
    expect(read(h, id).nodes["report-ready"]?.attempts).toBe(2);
    const key3 = await retryVerifyReport(h, id, spec, ctx, [{ cmd: "npm test", exit_code: 0, tests_passed: 642 }]);
    expect(key3).toBe(`${id}:verify-head:3`);
    expect(read(h, id).verdict?.level).toBe("unit-test-verified");
    expect(read(h, id).cursor).toBe("report-ready");
    expect(read(h, id).nodes["report-ready"]?.attempts).toBe(3);
    const done: any = await runTool(ctx, "keel_wait", { run_id: id });
    expect(done.ok, done.message).toBe(true);
    expect(done.result.next.kind).toBe("done");
  });

  it("attempt 2 npm test re-verify still reaches done after report-ready was already used twice", async () => {
    const { h, id, spec, ctx } = await boot("bug-fix", 2);
    const key = await retryVerifyReport(h, id, spec, ctx, [{ cmd: "npm test", exit_code: 0, tests_passed: 642 }]);
    expect(key).toBe(`${id}:verify-head:3`);
    expect(read(h, id).verdict?.level).toBe("unit-test-verified");
    expect(read(h, id).nodes["report-ready"]?.attempts).toBe(3);
    const done: any = await runTool(ctx, "keel_wait", { run_id: id });
    expect(done.ok, done.message).toBe(true);
    expect(done.result.next.kind).toBe("done");
  });

  it("feature two low re-verifies after two final reviews still reach done without extra open-pr", async () => {
    const { h, id, spec, ctx } = await boot("feature", 1, true, false);
    const key2 = await retryVerifyReport(h, id, spec, ctx, [{ cmd: "npm run verify", exit_code: 0, tests_passed: 0 }]);
    expect(key2).toBe(`${id}:verify-head:2`);
    const mid: any = await runTool(ctx, "keel_wait", { run_id: id });
    expect(mid.ok, mid.message).toBe(true);
    expect(mid.result.next.kind).toBe("decide");
    expect(mid.result.next.gate_id).toBe("human:verify-head");
    const key3 = await retryVerifyReport(h, id, spec, ctx, [{ cmd: "npm test", exit_code: 0, tests_passed: 642 }]);
    expect(key3).toBe(`${id}:verify-head:3`);
    const st = read(h, id);
    expect(st.nodes["open-pr"]?.attempts).toBe(2);
    expect(st.nodes["wait-ci"]?.attempts).toBe(2);
    expect(st.nodes["astra-final-review"]?.attempts).toBe(2);
    expect(st.cursor).toBe("report-ready");
    const done: any = await runTool(ctx, "keel_wait", { run_id: id });
    expect(done.ok, done.message).toBe(true);
    expect(done.result.next.kind).toBe("done");
  });
});
