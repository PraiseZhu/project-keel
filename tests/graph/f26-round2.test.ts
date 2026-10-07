import { describe, expect, it } from "vitest";
import { makeContext } from "../../src/main/context.ts";
import { runTool } from "../../src/main/dispatch.ts";
import { advance, createRun, prOpenSections } from "../../src/main/graph/interpreter.ts";
import type { GraphRunState } from "../../src/main/graph/state.ts";
import { graphStatePath, withRun } from "../../src/main/store/runs.ts";
import { PSTACK_GRAPHS } from "../../src/shared/graph/pstack.ts";
import { LANE_PRESETS } from "../../src/shared/types.ts";
import { fakeHost } from "../helpers/fakeHost.ts";

const profile = { lanes: [], routingPath: null, boardRepos: [], plansDir: null };
const HEAD_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEAD_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OLD_BASE = "cccccccccccccccccccccccccccccccccccccccc";
const NEW_BASE = "dddddddddddddddddddddddddddddddddddddddd";

function prSnap(head: string, baseRef = "main") {
  return {
    ok: true,
    result: {
      preset: "personal",
      rule: LANE_PRESETS.personal,
      pr: {
        repo: "o/r", number: 12, url: "https://github.com/o/r/pull/12", title: "t", state: "OPEN",
        isDraft: false, headSha: head, headRef: "feat/x", baseRef, mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN", reviewDecision: null, labels: [],
      },
      decision: { kind: "ready" },
      checks: { failed: [], pending: [], passed: 1 },
      unresolvedThreads: 0,
      gate: { applies: false, required: [], passed: [], failing: [], pending: [], missing: [], ok: true, sources: [] },
      verification: null,
      mergeReadyLabel: false,
    },
  };
}

async function plantVerifier(h: ReturnType<typeof fakeHost>, headSha: string, extra: Partial<GraphRunState> = {}) {
  const started: any = await runTool(makeContext(h, "c1", profile), "keel_run", {
    goal: "修登录报错", repo_dir: "/repo", lead: "codex", scope: ["src/**"],
  });
  const runId = started.result.run_id as string;
  const key = `${runId}:verify-same-surface:1`;
  await withRun(h, runId, (raw) => {
    const s = raw as unknown as GraphRunState;
    s.pr = 12;
    s.repo = "o/r";
    s.gh_repo = "o/r";
    s.worktree = "/repo/.worktrees/x";
    s.pr_binding = { repo: "o/r", number: 12, base_ref: "main", base_sha: OLD_BASE, head_sha: headSha };
    Object.assign(s, extra);
    s.nodes["verify-same-surface"] = {
      status: "active",
      attempts: 1,
      dispatch_key: key,
      dispatch_state: "running",
      planned_params: {
        label: "keel-ver-1", role: "keel-verifier", agent: "pi", model: "gpt-6-astra",
        provider_id: "art-cindy", initial_task: "v", writes: false, fallbacks: [], route_index: 0,
      },
      actual_route: { agent: "pi", model: "gpt-6-astra", provider_id: "art-cindy" },
    };
  });
  return { runId, key };
}

describe("F26-01 late report vs current PR head", () => {
  it("does not build a verdict when report head A is not current PR head B", async () => {
    const h = fakeHost({
      node: (method: string) => {
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "f", head: HEAD_B } };
        if (method === "worktree/create") return { ok: true, result: { path: "/repo/.worktrees/x" } };
        if (method === "pr/snapshot") return prSnap(HEAD_B);
        if (method === "pr/threads") return { ok: true, result: { threads: [] } };
        if (method === "git/base-sha") return { ok: true, result: { base_ref: "main", base_sha: OLD_BASE } };
        if (method === "git/patch-id") return { ok: true, result: { ok: true, patch_id: "p" } };
        return { ok: false, message: method };
      },
    });
    const { runId, key } = await plantVerifier(h, HEAD_B);
    await runTool(makeContext(h, "c2", profile), "keel_report", {
      run_id: runId, phase: "final", dispatch_key: key,
      inline_report: {
        status: "done", summary: "late",
        ran: [{ cmd: "npx vitest run", exit_code: 0, tests_passed: 5 }],
        files_changed: [], verdict: "PASS", head_sha: HEAD_A,
      },
    });
    const st = JSON.parse(h.files.get(graphStatePath(runId))!) as GraphRunState;
    expect(st.verdict).toBeUndefined();
    expect(st.nodes["verify-same-surface"]?.last_report?.head_matches).toBe(false);
  });

  it("retarget re-verify uses computed base_sha", async () => {
    const h = fakeHost({
      node: (method: string, params: Record<string, unknown>) => {
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "f", head: HEAD_A } };
        if (method === "worktree/create") return { ok: true, result: { path: "/repo/.worktrees/x" } };
        if (method === "pr/snapshot") return prSnap(HEAD_A, "develop");
        if (method === "pr/threads") return { ok: true, result: { threads: [] } };
        if (method === "git/base-sha") return { ok: true, result: { base_ref: "develop", base_sha: NEW_BASE } };
        if (method === "git/patch-id") {
          expect(params.base_sha).toBe(NEW_BASE);
          expect(params.head_sha).toBe(HEAD_A);
          return { ok: true, result: { ok: true, patch_id: "patch-new" } };
        }
        return { ok: false, message: method };
      },
    });
    const { runId, key } = await plantVerifier(h, HEAD_A);
    await runTool(makeContext(h, "c2", profile), "keel_report", {
      run_id: runId, phase: "final", dispatch_key: key,
      inline_report: {
        status: "done", summary: "ok",
        ran: [{ cmd: "npx vitest run", exit_code: 0, tests_passed: 5 }],
        files_changed: [], verdict: "PASS", head_sha: HEAD_A,
      },
    });
    const st = JSON.parse(h.files.get(graphStatePath(runId))!) as GraphRunState;
    expect(st.verdict?.base_sha).toBe(NEW_BASE);
    expect(st.verdict?.head).toBe(HEAD_A);
  });
});

describe("F26-02 investigation create_worker.working_dir", () => {
  it("falls back to invocation_dir when there is no worktree", async () => {
    const h = fakeHost({
      node: (method: string) => {
        if (method === "git/state") return { ok: true, result: { root: "/other/root", branch: "main", head: HEAD_A, gh_repo: "o/r" } };
        if (method === "git/content-fingerprint") return { ok: true, result: { head: HEAD_A, status_digest: "d", content_hash: "h" } };
        return { ok: false, message: method };
      },
    });
    const started: any = await runTool(makeContext(h, "c1", profile), "keel_run", {
      goal: "调查超时原理", repo_dir: "/invoked/path", lead: "codex", playbook: "investigation",
    });
    const setup: any = await runTool(makeContext(h, "c2", profile), "keel_report", {
      run_id: started.result.run_id,
      phase: "setup",
      outcome: { worker_permission_mode: "bypassPermissions", team_id: "t1" },
    });
    expect(setup.result.next.kind).toBe("dispatch");
    expect(setup.result.next.create_worker.working_dir).toBe("/invoked/path");
  });
});

describe("F26-04 retry_verify does not succeed the node", () => {
  it("human:verify-head + retry_verify re-dispatches instead of walking to report-ready", async () => {
    const h = fakeHost({
      node: (method: string) => {
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "f", head: HEAD_A } };
        if (method === "worktree/create") return { ok: true, result: { path: "/repo/.worktrees/x" } };
        return { ok: false, message: method };
      },
    });
    const spec = PSTACK_GRAPHS["bug-fix"];
    await createRun(h, {
      run_id: "run-rv", spec_id: spec.id, profile_id: "sol", lead_harness: "codex",
      task_type: "bug-fix", entry: "verify-head", goal: "修登录报错",
      worktree: "/repo/.worktrees/x", now: h.now(),
    });
    await withRun(h, "run-rv", (raw) => {
      const s = raw as unknown as GraphRunState;
      s.status = "waiting_human";
      s.cursor = "verify-head";
      s.team = { ready: true, team_id: "t1" };
      s.next = { kind: "decide", gate_id: "human:verify-head", question: "验证未通过", options: ["retry_verify", "stop"] };
      s.nodes["verify-head"] = { status: "failed", attempts: 1 };
    });
    const r: any = await runTool(makeContext(h, "c1", profile), "keel_gate", {
      run_id: "run-rv", gate_id: "human:verify-head", answer: "retry_verify",
    });
    expect(r.ok).toBe(true);
    expect(r.result.next.kind).toBe("dispatch");
    expect(r.result.next.dispatch_key).toMatch(/verify-head/);
    expect(JSON.parse(h.files.get(graphStatePath("run-rv"))!).cursor).toBe("verify-head");
  });
});

describe("F26-05 keel_wait does not complete a running verifier", () => {
  it("verify-head still running stays active after keel_wait", async () => {
    const h = fakeHost({
      node: (method: string) => {
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "f", head: HEAD_A } };
        if (method === "worktree/create") return { ok: true, result: { path: "/repo/.worktrees/x" } };
        return { ok: false, message: method };
      },
    });
    const spec = PSTACK_GRAPHS["bug-fix"];
    await createRun(h, {
      run_id: "run-vh", spec_id: spec.id, profile_id: "sol", lead_harness: "codex",
      task_type: "bug-fix", entry: "verify-head", goal: "修登录报错",
      worktree: "/repo/.worktrees/x", now: h.now(),
    });
    await withRun(h, "run-vh", (raw) => {
      const s = raw as unknown as GraphRunState;
      s.cursor = "verify-head";
      s.team = { ready: true, team_id: "t1" };
      s.nodes["verify-head"] = {
        status: "active", attempts: 1, dispatch_key: "run-vh:verify-head:1", dispatch_state: "running",
        planned_params: {
          label: "keel-ver", role: "keel-verifier", agent: "pi", model: "gpt-6-astra",
          provider_id: "art-cindy", initial_task: "v", writes: false, fallbacks: [], route_index: 0,
        },
      };
    });
    const r: any = await runTool(makeContext(h, "c1", profile), "keel_wait", { run_id: "run-vh" });
    expect(r.ok).toBe(true);
    const st = JSON.parse(h.files.get(graphStatePath("run-vh"))!) as GraphRunState;
    expect(st.nodes["verify-head"]?.status).not.toBe("succeeded");
    expect(st.nodes["verify-head"]?.dispatch_state).toBe("running");
  });
});

describe("investigation final reads report from invocation_dir", () => {
  it("final without worktree uses invocation_dir for report/read", async () => {
    const reads: Record<string, unknown>[] = [];
    const h = fakeHost({
      node: (method: string, params: Record<string, unknown>) => {
        if (method === "git/state") return { ok: true, result: { root: "/invoked", branch: "main", head: HEAD_A } };
        if (method === "git/content-fingerprint") return { ok: true, result: { head: HEAD_A, status_digest: "d", content_hash: "h" } };
        if (method === "report/read") {
          reads.push(params);
          return {
            ok: true,
            result: {
              path: "/invoked/.keel/explore-1.md",
              content: "```json\n" + JSON.stringify({
                dispatch_key: "run-inv:explore:1",
                status: "done",
                summary: "ok",
                files_changed: [],
                ran: [],
                citation: "https://example.com/x",
                sc_evidence: { "SC-1": true },
              }) + "\n```\n",
            },
          };
        }
        return { ok: false, message: method };
      },
    });
    const spec = PSTACK_GRAPHS.investigation;
    await createRun(h, {
      run_id: "run-inv", spec_id: spec.id, profile_id: "sol", lead_harness: "codex",
      task_type: "investigation", entry: "explore", goal: "调查超时原理",
      invocation_dir: "/invoked", sc: [{ id: "SC-1", text: "根因" }], now: h.now(),
    });
    const key = "run-inv:explore:1";
    await withRun(h, "run-inv", (raw) => {
      const s = raw as unknown as GraphRunState;
      s.team = { ready: true, team_id: "t1" };
      s.nodes.explore = {
        status: "active", attempts: 1, dispatch_key: key, dispatch_state: "running",
        planned_params: {
          label: "keel-ex", role: "keel-explorer", agent: "pi", model: "grok-4.6",
          provider_id: "art-cindy", initial_task: "e", writes: false, fallbacks: [], route_index: 0,
        },
      };
    });
    const r: any = await runTool(makeContext(h, "c1", profile), "keel_report", {
      run_id: "run-inv", phase: "final", dispatch_key: key,
    });
    expect(r.ok, r.message).toBe(true);
    expect(reads[0]).toMatchObject({ worktree: "/invoked", node: "explore", attempt: 1 });
  });
});

describe("F26-06 open-pr next.call includes sections", () => {
  it("pr_open accepts next.call.args plus authorization_source", async () => {
    const h = fakeHost({
      node: (method: string) => {
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "f", head: HEAD_A } };
        if (method === "pr/resolve") return { ok: true, result: null };
        if (method === "pr/open") return { ok: true, result: { url: "https://github.com/o/r/pull/1", number: 1, repo: "o/r", head_sha: HEAD_A } };
        return { ok: false, message: method };
      },
    });
    const spec = PSTACK_GRAPHS.pr;
    await createRun(h, {
      run_id: "run-open", spec_id: spec.id, profile_id: "sol", lead_harness: "codex",
      task_type: "pr", entry: "open-pr", goal: "推进已有功能",
      worktree: "/repo/.worktrees/x", sc: [{ id: "SC-1", text: "可合并" }], now: h.now(),
    });
    const r = await advance(h, "run-open", { type: "tick" }, { spec });
    expect(r.next.kind).toBe("wait");
    if (r.next.kind !== "wait") throw new Error("wait");
    expect(r.next.call.tool).toBe("pr_open");
    const args = r.next.call.args as Record<string, unknown>;
    expect(args.sections).toEqual(prOpenSections(JSON.parse(h.files.get(graphStatePath("run-open"))!)));
    const opened: any = await runTool(makeContext(h, "c1", profile), "pr_open", {
      ...args,
      authorization_source: "用户 2026-10-04：提交 PR",
    });
    expect(opened.ok).toBe(true);
    expect(opened.result.number).toBe(1);
  });
});
