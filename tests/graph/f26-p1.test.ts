import { describe, expect, it } from "vitest";
import { makeContext } from "../../src/main/context.ts";
import { runTool } from "../../src/main/dispatch.ts";
import { createRun } from "../../src/main/graph/interpreter.ts";
import type { GraphRunState } from "../../src/main/graph/state.ts";
import { graphStatePath, withRun } from "../../src/main/store/runs.ts";
import { ghRepoOf, isGhRepo, runDoneCheck } from "../../src/main/tools/keel.ts";
import { PSTACK_GRAPHS } from "../../src/shared/graph/pstack.ts";
import { LANE_PRESETS } from "../../src/shared/types.ts";
import { fakeHost } from "../helpers/fakeHost.ts";

const profile = { lanes: [], routingPath: null, boardRepos: [], plansDir: null };
const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OLD_BASE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const NEW_BASE = "cccccccccccccccccccccccccccccccccccccccc";
const START = "dddddddddddddddddddddddddddddddddddddddd";

function prSnap(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    result: {
      preset: "personal",
      rule: LANE_PRESETS.personal,
      pr: {
        repo: "o/r", number: 12, url: "https://github.com/o/r/pull/12", title: "t", state: "OPEN",
        isDraft: false, headSha: HEAD, headRef: "feat/x", baseRef: "develop", mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN", reviewDecision: null, labels: [],
      },
      decision: { kind: "ready" },
      checks: { failed: [], pending: [], passed: 1 },
      unresolvedThreads: 0,
      gate: { applies: false, required: [], passed: [], failing: [], pending: [], missing: [], ok: true, sources: [] },
      verification: null,
      mergeReadyLabel: false,
      ...over,
    },
  };
}

describe("F26-01 current base is PR merge-base, not verdict.base", () => {
  it("retargeted base makes the old verdict fail done", async () => {
    const bases: unknown[] = [];
    const h = fakeHost({
      node: (method: string, params: Record<string, unknown>) => {
        if (method === "git/state") return { ok: true, result: { head: HEAD } };
        if (method === "pr/snapshot") return prSnap();
        if (method === "pr/threads") return { ok: true, result: { threads: [] } };
        if (method === "git/base-sha") {
          expect(params.base_ref).toBe("develop");
          return { ok: true, result: { base_ref: "develop", base_sha: NEW_BASE } };
        }
        if (method === "git/patch-id") {
          bases.push(params.base_sha);
          return { ok: true, result: { ok: true, patch_id: params.base_sha === NEW_BASE ? "patch-new" : "patch-old" } };
        }
        return { ok: false, message: method };
      },
    });
    const state = {
      run_id: "r1",
      task_type: "bug-fix",
      spec_id: "bug-fix",
      gh_repo: "o/r",
      repo: "o/r",
      pr: 12,
      worktree: "/repo/wt",
      sc: [{ id: "SC-1", text: "x" }],
      status: "running",
      nodes: {
        implement: {
          attempts: 1, planned_params: { writes: true }, actual_route: { model: "grok-4.6" },
          last_report: { status: "done", sc_evidence: { "SC-1": true } },
        },
      },
      pr_binding: { repo: "o/r", number: 12, base_ref: "main", base_sha: OLD_BASE, head_sha: HEAD },
      verdict: {
        head: HEAD, base_ref: "main", base_sha: OLD_BASE, patch_id: "patch-old",
        level: "unit-test-verified", by_route: { agent: "pi", model: "gpt-6-astra", provider_id: "art-cindy" }, by_family: "gpt",
      },
      author_families: ["grok"],
    } as unknown as GraphRunState;
    const r = await runDoneCheck(makeContext(h, "c1"), state);
    expect(r.ok).toBe(false);
    expect(bases).toEqual([NEW_BASE]);
  });
});

describe("F26-02 identity split", () => {
  it("investigation fingerprints the invocation_dir, not the git root", async () => {
    const dirs: string[] = [];
    const h = fakeHost({
      node: (method: string, params: Record<string, unknown>) => {
        if (method === "git/state") return { ok: true, result: { root: "/other/root", branch: "main", head: HEAD, gh_repo: "o/r" } };
        if (method === "git/content-fingerprint") {
          dirs.push(String(params.repo_dir));
          return { ok: true, result: { head: HEAD, status_digest: "d", content_hash: "h" } };
        }
        return { ok: false, message: method };
      },
    });
    const started: any = await runTool(makeContext(h, "c1", profile), "keel_run", {
      goal: "调查超时原理", repo_dir: "/invoked/path", lead: "codex", playbook: "investigation",
    });
    expect(started.ok).toBe(true);
    const st = JSON.parse(h.files.get(graphStatePath(started.result.run_id))!) as GraphRunState;
    expect(st.invocation_dir).toBe("/invoked/path");
    expect(st.repo_root).toBe("/other/root");
    expect(st.gh_repo).toBe("o/r");
    expect(isGhRepo(st.repo)).toBe(true);
    expect(ghRepoOf(st)).toBe("o/r");
    expect(dirs[0]).toBe("/invoked/path");
    st.cursor = "done";
    st.team = { ready: true };
    st.nodes.report = { status: "succeeded", attempts: 1, last_report: { status: "done", summary: "ok", citation: "n.md:1", sc_evidence: { "SC-1": true }, fresh: true } };
    st.sc = [{ id: "SC-1", text: "根因" }];
    h.files.set(graphStatePath(st.run_id), JSON.stringify(st));
    await runTool(makeContext(h, "c2", profile), "keel_gate", { run_id: st.run_id, gate_id: "unused", answer: "x" });
    expect(dirs.at(-1)).toBe("/invoked/path");
  });
});

describe("F26-03 committed out-of-scope files", () => {
  it("final with base=start_sha reports SCOPE_VIOLATION for a committed out-of-scope file", async () => {
    let seenBase: unknown;
    const h = fakeHost({
      node: (method: string, params: Record<string, unknown>) => {
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "f", head: START, gh_repo: "o/r" } };
        if (method === "worktree/create") return { ok: true, result: { path: "/repo/.worktrees/x" } };
        if (method === "git/changed-files") {
          seenBase = params.base;
          return { ok: true, result: { files: ["outside.txt"] } };
        }
        return { ok: false, message: method };
      },
    });
    const started: any = await runTool(makeContext(h, "c1", profile), "keel_run", {
      goal: "修登录报错", repo_dir: "/repo", lead: "codex", scope: ["src/**"],
    });
    const runId = started.result.run_id as string;
    const key = `${runId}:implement:1`;
    await withRun(h, runId, (raw) => {
      const s = raw as unknown as GraphRunState;
      s.nodes.implement = {
        status: "active",
        attempts: 1,
        dispatch_key: key,
        dispatch_state: "running",
        planned_params: {
          label: "keel-impl-1", role: "keel-worker", agent: "pi", model: "grok-4.6", provider_id: "art-cindy",
          initial_task: "x", writes: true, fallbacks: [], route_index: 0, scopeAllow: ["src/**"], start_sha: START,
        },
      };
    });
    const r: any = await runTool(makeContext(h, "c2", profile), "keel_report", {
      run_id: runId,
      phase: "final",
      dispatch_key: key,
      inline_report: { status: "done", summary: "ok", files_changed: ["outside.txt"], ran: [{ cmd: "npm test", exit_code: 0 }] },
    });
    expect(r).toMatchObject({ ok: false, errorCode: "SCOPE_VIOLATION" });
    expect(seenBase).toBe(START);
  });

  it("records start_sha at plan; a commit before accepted is still in scope", async () => {
    const START_HEAD = START;
    const AFTER_COMMIT = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    let head = START_HEAD;
    let seenBase: unknown;
    const h = fakeHost({
      node: (method: string, params: Record<string, unknown>) => {
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "f", head, gh_repo: "o/r" } };
        if (method === "worktree/create") return { ok: true, result: { path: "/repo/.worktrees/x" } };
        if (method === "git/changed-files") {
          seenBase = params.base;
          if (params.base === START_HEAD) return { ok: true, result: { files: ["outside.txt"] } };
          return { ok: true, result: { files: [] } };
        }
        return { ok: false, message: method };
      },
    });
    const started: any = await runTool(makeContext(h, "c1", profile), "keel_run", {
      goal: "修登录报错", repo_dir: "/repo", lead: "codex", scope: ["src/**"],
    });
    const runId = started.result.run_id as string;
    const setup: any = await runTool(makeContext(h, "c2", profile), "keel_report", {
      run_id: runId,
      phase: "setup",
      outcome: { worker_permission_mode: "bypassPermissions", team_id: "t1" },
    });
    expect(setup.ok).toBe(true);
    expect(setup.result.next.kind).toBe("dispatch");
    const stPlan = JSON.parse(h.files.get(graphStatePath(runId))!) as GraphRunState;
    const nodeId = Object.keys(stPlan.nodes).find((id) => stPlan.nodes[id]?.dispatch_key === setup.result.next.dispatch_key)!;
    expect(stPlan.nodes[nodeId]?.planned_params?.start_sha).toBe(START_HEAD);
    head = AFTER_COMMIT;
    const acc: any = await runTool(makeContext(h, "c3", profile), "keel_report", {
      run_id: runId,
      phase: "accepted",
      dispatch_key: setup.result.next.dispatch_key,
      worker_id: "w1",
      worker_session_id: "s1",
      dispatch_outcome: { dispatched: true, wakeKind: "immediate" },
    });
    expect(acc.ok).toBe(true);
    expect(JSON.parse(h.files.get(graphStatePath(runId))!).nodes[nodeId].planned_params.start_sha).toBe(START_HEAD);
    const fin: any = await runTool(makeContext(h, "c4", profile), "keel_report", {
      run_id: runId,
      phase: "final",
      dispatch_key: setup.result.next.dispatch_key,
      inline_report: { status: "done", summary: "ok", files_changed: ["outside.txt"], ran: [{ cmd: "npm test", exit_code: 0 }] },
    });
    expect(fin).toMatchObject({ ok: false, errorCode: "SCOPE_VIOLATION" });
    expect(seenBase).toBe(START_HEAD);
  });

  it("does not dispatch a write node when plan-time HEAD is unknown", async () => {
    const h = fakeHost({
      node: (method: string) => {
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "f", gh_repo: "o/r" } };
        if (method === "worktree/create") return { ok: true, result: { path: "/repo/.worktrees/x" } };
        return { ok: false, message: method };
      },
    });
    const started: any = await runTool(makeContext(h, "c1", profile), "keel_run", {
      goal: "修登录报错", repo_dir: "/repo", lead: "codex", scope: ["src/**"],
    });
    const blocked: any = await runTool(makeContext(h, "c2", profile), "keel_report", {
      run_id: started.result.run_id,
      phase: "setup",
      outcome: { worker_permission_mode: "bypassPermissions", team_id: "t1" },
    });
    expect(blocked.ok).toBe(true);
    expect(blocked.result.next).toMatchObject({ kind: "decide" });
    expect(blocked.result.next.question).toMatch(/HEAD/);
    expect(blocked.result.next.kind === "dispatch").toBe(false);
  });
});

describe("F26-07 plugin task ids pass through accepted", () => {
  it("keel_report accepted keeps task_id, revision, then task_run_id", async () => {
    const h = fakeHost({
      node: (method: string) => {
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "main", head: HEAD, gh_repo: "o/r" } };
        if (method === "git/content-fingerprint") return { ok: true, result: { head: HEAD, status_digest: "d", content_hash: "h" } };
        return { ok: false, message: method };
      },
    });
    const spec = PSTACK_GRAPHS.investigation;
    await createRun(h, {
      run_id: "run-plug",
      spec_id: spec.id,
      profile_id: "sol",
      lead_harness: "codex",
      task_type: "investigation",
      entry: "research",
      goal: "调查",
      invocation_dir: "/repo",
      now: h.now(),
    });
    const key = "run-plug:research:1";
    await withRun(h, "run-plug", (raw) => {
      const s = raw as unknown as GraphRunState;
      s.team = { ready: true, team_id: "t1" };
      s.nodes.research = {
        status: "active",
        attempts: 1,
        dispatch_key: key,
        dispatch_state: "planned",
        task: { create_request_key: "create:k", create_body: {}, phase: "create" },
      };
    });
    const created: any = await runTool(makeContext(h, "c1", profile), "keel_report", {
      run_id: "run-plug",
      phase: "accepted",
      dispatch_key: key,
      task_id: "task-9",
      revision: 3,
    });
    expect(created.ok).toBe(true);
    const afterCreate = JSON.parse(h.files.get(graphStatePath("run-plug"))!) as GraphRunState;
    expect(afterCreate.nodes.research?.task).toMatchObject({ task_id: "task-9", revision: 3, phase: "send" });
    const sent: any = await runTool(makeContext(h, "c2", profile), "keel_report", {
      run_id: "run-plug",
      phase: "accepted",
      dispatch_key: key,
      task_run_id: "trun-9",
    });
    expect(sent.ok).toBe(true);
    const afterSend = JSON.parse(h.files.get(graphStatePath("run-plug"))!) as GraphRunState;
    expect(afterSend.nodes.research?.task?.run_id).toBe("trun-9");
  });
});

describe("F26-04 keel_gate consumes the current decide", () => {
  it("adopt from await_sol walks the gate edge; stop stops", async () => {
    const h = fakeHost({
      node: (method: string) => {
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "f", head: HEAD } };
        if (method === "worktree/create") return { ok: true, result: { path: "/repo/.worktrees/x" } };
        return { ok: false, message: method };
      },
    });
    const spec = PSTACK_GRAPHS["bug-fix"];
    await createRun(h, {
      run_id: "run-gate",
      spec_id: spec.id,
      profile_id: "sol",
      lead_harness: "codex",
      task_type: "bug-fix",
      entry: "g-accept",
      goal: "修登录报错",
      worktree: "/repo/.worktrees/x",
      now: h.now(),
    });
    await withRun(h, "run-gate", (raw) => {
      const s = raw as unknown as GraphRunState;
      s.status = "await_sol";
      s.cursor = "g-accept";
      s.team = { ready: true, team_id: "t1" };
      s.next = { kind: "decide", gate_id: "g-accept", question: "门 g-accept", options: ["adopt", "revise", "ask_user"] };
      s.nodes["g-accept"] = { status: "active", attempts: 1 };
    });
    const adopt: any = await runTool(makeContext(h, "c1", profile), "keel_gate", {
      run_id: "run-gate", gate_id: "g-accept", answer: "adopt",
    });
    expect(adopt.ok).toBe(true);
    expect(adopt.result.next.kind).not.toBe("decide");
    const st = JSON.parse(h.files.get(graphStatePath("run-gate"))!) as GraphRunState;
    expect(st.status).not.toBe("await_sol");
    expect(st.cursor).toBe("verify-head");

    const h2 = fakeHost();
    await createRun(h2, {
      run_id: "run-stop",
      spec_id: spec.id,
      profile_id: "sol",
      lead_harness: "codex",
      task_type: "bug-fix",
      entry: "g-accept",
      goal: "修登录报错",
      now: h2.now(),
    });
    await withRun(h2, "run-stop", (raw) => {
      const s = raw as unknown as GraphRunState;
      s.status = "await_sol";
      s.cursor = "g-accept";
      s.next = { kind: "decide", gate_id: "g-accept", question: "门", options: ["adopt", "revise", "ask_user", "stop"] };
      s.nodes["g-accept"] = { status: "active", attempts: 1 };
    });
    const stopped: any = await runTool(makeContext(h2, "c1", profile), "keel_gate", {
      run_id: "run-stop", gate_id: "g-accept", answer: "stop",
    });
    expect(stopped.ok).toBe(true);
    expect(stopped.result.next.kind).toBe("stop");
    expect(JSON.parse(h2.files.get(graphStatePath("run-stop"))!).status).toBe("stopped");
  });
});

describe("F26-05 keel_wait does not complete a running worker", () => {
  it("fix-ci still running stays active after keel_wait", async () => {
    const h = fakeHost({
      node: (method: string) => {
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "f", head: HEAD } };
        if (method === "worktree/create") return { ok: true, result: { path: "/repo/.worktrees/x" } };
        return { ok: false, message: method };
      },
    });
    const spec = PSTACK_GRAPHS["bug-fix"];
    await createRun(h, {
      run_id: "run-fix",
      spec_id: spec.id,
      profile_id: "sol",
      lead_harness: "codex",
      task_type: "bug-fix",
      entry: "fix-ci",
      goal: "修登录报错",
      worktree: "/repo/.worktrees/x",
      now: h.now(),
    });
    const key = "run-fix:fix-ci:1";
    await withRun(h, "run-fix", (raw) => {
      const s = raw as unknown as GraphRunState;
      s.cursor = "fix-ci";
      s.team = { ready: true, team_id: "t1" };
      s.status = "running";
      s.nodes["fix-ci"] = {
        status: "active",
        attempts: 1,
        dispatch_key: key,
        dispatch_state: "running",
        planned_params: {
          label: "keel-fix", role: "keel-worker", agent: "pi", model: "grok-4.6", provider_id: "art-cindy",
          initial_task: "x", writes: true, fallbacks: [], route_index: 0,
        },
      };
    });
    const r: any = await runTool(makeContext(h, "c1", profile), "keel_wait", { run_id: "run-fix" });
    expect(r.ok).toBe(true);
    const st = JSON.parse(h.files.get(graphStatePath("run-fix"))!) as GraphRunState;
    expect(st.nodes["fix-ci"]?.status).not.toBe("succeeded");
    expect(st.nodes["fix-ci"]?.dispatch_state).toBe("running");
  });
});

describe("F26-07 / team_id from get_workspace_info at reconcile", () => {
  it("reconcile uses workflow id, not the stored team_id copy", async () => {
    const h = fakeHost({
      node: (method: string) => {
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "f", head: HEAD } };
        if (method === "worktree/create") return { ok: true, result: { path: "/repo/.worktrees/x" } };
        return { ok: false, message: method };
      },
    });
    const spec = PSTACK_GRAPHS["bug-fix"];
    await createRun(h, {
      run_id: "run-rec",
      spec_id: spec.id,
      profile_id: "sol",
      lead_harness: "codex",
      task_type: "bug-fix",
      entry: "implement",
      goal: "修登录报错",
      worktree: "/repo/.worktrees/x",
      now: h.now(),
    });
    const key = "run-rec:implement:1";
    await withRun(h, "run-rec", (raw) => {
      const s = raw as unknown as GraphRunState;
      s.cursor = "implement";
      s.team = { ready: true, team_id: "wf-live" };
      s.nodes.implement = {
        status: "active",
        attempts: 1,
        dispatch_key: key,
        dispatch_state: "reconciling",
        team_id: "wf-live",
        planned_params: {
          label: "keel-impl", role: "keel-worker", agent: "pi", model: "grok-4.6", provider_id: "art-cindy",
          initial_task: "x", writes: true, fallbacks: [], route_index: 0,
        },
      };
    });
    const r: any = await runTool(makeContext(h, "c1", profile), "keel_report", {
      run_id: "run-rec",
      phase: "reconcile",
      dispatch_key: key,
      queries_result: {
        list_workers: { ok: true, complete: true, team_id: "stale-copy", workers: [{ label: "keel-impl", worker_id: "w1", worker_session_id: "ws1", status: "running" }] },
        get_worker_queue_status: { ok: true, pending: [], consuming: null },
      },
      get_workspace_info: { ok: true, workflow: { workflow_id: "wf-live", lead_session_id: "sess-live", status: "active" }, workers: [] },
    });
    expect(r.ok).toBe(true);
    expect(r.result.next.kind).not.toBe("decide");
  });
});

describe("keel_wait hands back a pending non-wait next (real run: setup after reinstall)", () => {
  it("returns the stored setup next instead of a 'how to wait' gate", async () => {
    const h = fakeHost({ node: () => ({ ok: false, message: "unused" }) });
    const spec = PSTACK_GRAPHS["bug-fix"];
    await createRun(h, { run_id: "run-pend", spec_id: spec.id, profile_id: "sol", lead_harness: "codex", task_type: "bug-fix", entry: "implement", goal: "g", worktree: "/repo/.worktrees/x", now: h.now() });
    const setup = { kind: "setup", call: { tool: "start_team", args: { worker_permission_mode: "bypassPermissions" } }, after: "keel_report phase=setup" };
    await withRun(h, "run-pend", (raw) => {
      const s = raw as unknown as GraphRunState;
      s.cursor = "implement";
      s.status = "running";
      (s as { next?: unknown }).next = setup;
    });
    const r: any = await runTool(makeContext(h, "c1", profile), "keel_wait", { run_id: "run-pend" });
    expect(r).toMatchObject({ ok: true, result: { next: setup } });
  });
});
