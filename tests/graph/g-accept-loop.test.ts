import { describe, expect, it } from "vitest";
import { makeContext } from "../../src/main/context.ts";
import { runTool } from "../../src/main/dispatch.ts";
import { advance, createRun, prOpenSections, scrubLocalPaths } from "../../src/main/graph/interpreter.ts";
import type { GraphRunState } from "../../src/main/graph/state.ts";
import { graphStatePath, withRun } from "../../src/main/store/runs.ts";
import { PSTACK_GRAPHS } from "../../src/shared/graph/pstack.ts";
import { LANE_PRESETS } from "../../src/shared/types.ts";
import { fakeHost } from "../helpers/fakeHost.ts";
import { readState } from "./helpers.ts";

const HEAD = "a".repeat(40);
const WT = "/repo/.worktrees/keel-run-x";

async function bootAccept(runId: string, specId: "bug-fix" | "pr", verdict?: string) {
  const spec = PSTACK_GRAPHS[specId];
  const h = fakeHost({
    node: (method: string) => {
      if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "feat/x", head: HEAD } };
      return { ok: false, message: method };
    },
  });
  await createRun(h, {
    run_id: runId,
    spec_id: spec.id,
    profile_id: "sol",
    lead_harness: "codex",
    task_type: specId,
    entry: "g-accept",
    goal: "修登录报错",
    worktree: WT,
    now: h.now(),
    scopeAllow: ["src/**"],
  });
  await withRun(h, runId, (raw) => {
    const s = raw as unknown as GraphRunState;
    s.team = { ready: true, team_id: "t1", lead_session_id: "lead" };
    s.cursor = "g-accept";
    s.nodes["astra-final-review"] = {
      status: "succeeded",
      attempts: 1,
      dispatch_state: "terminal",
      report_path: `${WT}/.keel/astra-final-review-1.md`,
      last_report: {
        status: "done",
        summary: verdict === "FAIL" ? "终审不通过" : "终审通过",
        ...(verdict ? { verdict } : {}),
      },
    };
    s.nodes["g-accept"] = { status: "pending", attempts: 0 };
    s.nodes.implement = {
      status: "succeeded",
      attempts: 1,
      dispatch_state: "terminal",
      report_path: `${WT}/.keel/implement-1.md`,
      last_report: { status: "done", summary: "已实现" },
    };
  });
  return { h, spec };
}

describe("g-accept FAIL revises without Jev", () => {
  it("FAIL walks to implement on bug-fix and does not open human-accept", async () => {
    const { h, spec } = await bootAccept("run-fail", "bug-fix", "FAIL");
    const r = await advance(h, "run-fail", { type: "tick" }, { spec, gates: { accept: () => "ask_user" } });
    const st = readState(h, "run-fail");
    expect(st.cursor).toBe("implement");
    expect(st.status).not.toBe("waiting_human");
    expect(st.status).not.toBe("await_sol");
    expect(r.next.kind).toBe("dispatch");
    if (r.next.kind !== "dispatch") throw new Error("dispatch");
    expect(r.next.dispatch_key).toBe("run-fail:implement:2");
    expect(r.next.create_worker?.initial_task).toContain("先读这些已完成报告再动手");
    expect(r.next.create_worker?.initial_task).toContain(`${WT}/.keel/astra-final-review-1.md`);
  });

  it("FAIL walks to fix-ci on the pr graph", async () => {
    const { h, spec } = await bootAccept("run-pr-fail", "pr", "FAIL");
    await advance(h, "run-pr-fail", { type: "tick" }, { spec });
    expect(readState(h, "run-pr-fail").cursor).toBe("fix-ci");
  });

  it("pr graph FAIL dispatch of fix-ci:1 lists prior reports and skips tool nodes", async () => {
    const { h, spec } = await bootAccept("run-pr-fail-brief", "pr", "FAIL");
    await withRun(h, "run-pr-fail-brief", (raw) => {
      const s = raw as unknown as GraphRunState;
      s.nodes["open-pr"] = { status: "succeeded", attempts: 1, dispatch_state: "terminal" };
      s.nodes["wait-ci"] = { status: "succeeded", attempts: 1, dispatch_state: "terminal" };
      s.nodes["ci-rerun-once"] = { status: "succeeded", attempts: 1, dispatch_state: "terminal" };
      s.nodes["report-ready"] = { status: "succeeded", attempts: 1, dispatch_state: "terminal" };
    });
    const r = await advance(h, "run-pr-fail-brief", { type: "tick" }, { spec });
    expect(r.next.kind).toBe("dispatch");
    if (r.next.kind !== "dispatch") throw new Error("dispatch");
    expect(r.next.dispatch_key).toBe("run-pr-fail-brief:fix-ci:1");
    const task = r.next.create_worker?.initial_task ?? "";
    expect(task).toContain("先读这些已完成报告再动手");
    expect(task).toContain(`${WT}/.keel/astra-final-review-1.md`);
    expect(task).not.toContain(`${WT}/.keel/open-pr-1.md`);
    expect(task).not.toContain(`${WT}/.keel/wait-ci-1.md`);
    expect(task).not.toContain(`${WT}/.keel/ci-rerun-once-1.md`);
    expect(task).not.toContain(`${WT}/.keel/report-ready-1.md`);
  });

  it("PASS and PASS+NOTES walk to verify-head", async () => {
    for (const verdict of ["PASS", "PASS+NOTES"] as const) {
      const runId = verdict === "PASS" ? "run-pass" : "run-pass-notes";
      const { h, spec } = await bootAccept(runId, "bug-fix", verdict);
      await advance(h, runId, { type: "tick" }, { spec, gates: { accept: () => "ask_user" } });
      expect(readState(h, runId).cursor).toBe("verify-head");
    }
  });

  it("missing verdict still asks (does not auto-revise)", async () => {
    const { h, spec } = await bootAccept("run-none", "bug-fix");
    const r = await advance(h, "run-none", { type: "tick" }, { spec });
    expect(r.next.kind).toBe("decide");
    if (r.next.kind !== "decide") throw new Error("decide");
    expect(r.next.gate_id).toBe("g-accept");
    expect(r.next.options).toEqual(["adopt", "revise", "ask_user"]);
    expect(readState(h, "run-none").cursor).toBe("g-accept");
  });
});

describe("open-pr title and sections strip local paths", () => {
  it("replaces /Users /home /private /var/folders prefixes with the filename /Users/you/", () => {
    expect(scrubLocalPaths("修 /Users/you/src/login.ts 空指针")).toBe("修 login.ts 空指针");
    expect(scrubLocalPaths("see /home/u/app/foo.ts and /private/tmp/x.md")).toBe("see foo.ts and x.md"); // /Users/you/
    expect(scrubLocalPaths("cache /var/folders/zz/abc/T/t.ts leftover")).toBe("cache t.ts leftover");
    expect(scrubLocalPaths("keep https://github.com/acme/app/blob/main/src/a.ts")).toBe("keep https://github.com/acme/app/blob/main/src/a.ts");
    expect(scrubLocalPaths("在 /Users/you/projects/Project Keel/src/login.ts 修")).toBe("在 login.ts 修");
  });

  it("strips paths after = : and CJK adjacency /Users/you/", () => {
    expect(scrubLocalPaths("path=/Users/you/work/a.ts leftover")).toBe("path=a.ts leftover");
    expect(scrubLocalPaths("path:/home/example/work/a.ts leftover")).toBe("path:a.ts leftover"); // /Users/you/
    expect(scrubLocalPaths("修/Users/you/src/secret.ts完")).toBe("修secret.ts完");
    expect(scrubLocalPaths("见/private/tmp/x.md。")).toBe("见x.md。");
    expect(scrubLocalPaths("cache=/var/folders/zz/abc/T/t.ts")).toBe("cache=t.ts");
  });

  it("pr_open next args do not leak machine-local absolute paths in title or sections", async () => {
    const spec = PSTACK_GRAPHS.pr;
    const h = fakeHost();
    const wt = "/Users/you/projects/Project Keel/.worktrees/x";
    await createRun(h, {
      run_id: "run-path",
      spec_id: spec.id,
      profile_id: "sol",
      lead_harness: "codex",
      task_type: "pr",
      entry: "open-pr",
      goal: "修 /Users/you/projects/Project Keel/src/login.ts 空指针",
      worktree: wt,
      now: h.now(),
      sc: [{ id: "SC-1", text: "覆盖 /home/u/repo/tests/login.test.ts" }], // /Users/you/
    });
    await withRun(h, "run-path", (raw) => {
      const s = raw as unknown as GraphRunState;
      s.nodes.implement = {
        status: "succeeded",
        attempts: 1,
        last_report: { status: "done", summary: "改了 /private/tmp/scratch.ts" },
      };
    });
    const r = await advance(h, "run-path", { type: "tick" }, { spec });
    expect(r.next.kind).toBe("wait");
    if (r.next.kind !== "wait") throw new Error("wait");
    const args = r.next.call.args as { title?: string; sections?: Record<string, string>; repo_dir?: string };
    expect(args.title).toBe("修 login.ts 空指针");
    expect(JSON.stringify(args.title)).not.toMatch(/\/Users\/|\/home\/|\/private\/|\/var\/folders\//);
    const sections = args.sections ?? prOpenSections(readState(h, "run-path"));
    for (const key of ["summary", "goal", "acceptance", "notes"] as const) {
      expect(sections[key], key).not.toMatch(/\/Users\/|\/home\/|\/private\/|\/var\/folders\//);
    }
    expect(sections.goal).toContain("login.ts");
    expect(sections.acceptance).toContain("login.test.ts");
    expect(sections.notes).toContain("scratch.ts");
    expect(args.repo_dir).toBe(wt);
  });
});

describe("writing-node retry brief from interpreter", () => {
  it("attempt 1 has no prior-report instruction; attempt 2 lists the final-review path", async () => {
    const spec = PSTACK_GRAPHS["bug-fix"];
    const h = fakeHost({
      node: (method: string) => {
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "feat/x", head: HEAD } };
        return { ok: false, message: method };
      },
    });
    await createRun(h, {
      run_id: "run-brief",
      spec_id: spec.id,
      profile_id: "sol",
      lead_harness: "codex",
      task_type: "bug-fix",
      entry: "implement",
      goal: "修登录报错",
      worktree: WT,
      now: h.now(),
      scopeAllow: ["src/**"],
    });
    await withRun(h, "run-brief", (raw) => {
      const s = raw as unknown as GraphRunState;
      s.team = { ready: true, team_id: "t1", lead_session_id: "lead" };
      s.cursor = "implement";
    });
    const first = await advance(h, "run-brief", { type: "tick" }, { spec });
    expect(first.next.kind).toBe("dispatch");
    if (first.next.kind !== "dispatch") throw new Error("dispatch");
    expect(first.next.create_worker?.initial_task).not.toContain("先读这些已完成报告再动手");

    await withRun(h, "run-brief", (raw) => {
      const s = raw as unknown as GraphRunState;
      s.cursor = "implement";
      s.next = undefined;
      s.status = "running";
      const n = s.nodes.implement!;
      n.status = "failed";
      n.dispatch_state = "terminal";
      n.dispatch_key = undefined;
      n.report_path = `${WT}/.keel/implement-1.md`;
      n.last_report = { status: "failed", summary: "未过" };
      s.nodes["astra-final-review"] = {
        status: "succeeded",
        attempts: 1,
        dispatch_state: "terminal",
        report_path: `${WT}/.keel/astra-final-review-1.md`,
        last_report: { status: "done", verdict: "FAIL", summary: "终审不通过" },
      };
    });
    const second = await advance(h, "run-brief", { type: "tick" }, { spec });
    expect(second.next.kind).toBe("dispatch");
    if (second.next.kind !== "dispatch") throw new Error("dispatch");
    expect(second.next.dispatch_key).toBe("run-brief:implement:2");
    const task = second.next.create_worker?.initial_task ?? "";
    expect(task).toContain("先读这些已完成报告再动手");
    expect(task).toContain(`${WT}/.keel/astra-final-review-1.md`);
    expect(task).toContain(`${WT}/.keel/implement-1.md`);
  });
});

async function bootFinalAttempt(runId: string, specId: "bug-fix" | "pr") {
  const spec = PSTACK_GRAPHS[specId];
  const h = fakeHost({
    node: (method: string) => {
      if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "feat/x", head: HEAD } };
      return { ok: false, message: method };
    },
  });
  const key = `${runId}:astra-final-review:1`;
  await createRun(h, {
    run_id: runId,
    spec_id: spec.id,
    profile_id: "sol",
    lead_harness: "codex",
    task_type: specId,
    entry: "astra-final-review",
    goal: "修登录报错",
    worktree: WT,
    now: h.now(),
    scopeAllow: ["src/**"],
  });
  await withRun(h, runId, (raw) => {
    const s = raw as unknown as GraphRunState;
    s.team = { ready: true, team_id: "t1", lead_session_id: "lead" };
    s.cursor = "astra-final-review";
    s.budget.astra_left = 3;
    s.nodes["astra-final-review"] = {
      status: "active",
      attempts: 1,
      dispatch_key: key,
      dispatch_state: "running",
    };
  });
  return { h, spec, key };
}

describe("final FAIL with failed/blocked status still revises", () => {
  it.each([
    ["failed", "bug-fix", "implement"],
    ["blocked", "bug-fix", "implement"],
    ["failed", "pr", "fix-ci"],
  ] as const)("status=%s on %s walks to %s", async (status, specId, dest) => {
    const { h, spec, key } = await bootFinalAttempt(`run-${specId}-${status}`, specId);
    const r = await advance(h, `run-${specId}-${status}`, {
      type: "report",
      phase: "final",
      dispatch_key: key,
      report: { status, verdict: "FAIL", summary: "终审不通过" },
    }, { spec, gates: { accept: () => "ask_user" } });
    const st = readState(h, `run-${specId}-${status}`);
    expect(st.cursor).toBe(dest);
    expect(st.status).not.toBe("waiting_human");
    expect(st.status).not.toBe("await_sol");
    expect(st.nodes["astra-final-review"]?.last_report?.status).toBe(status);
    expect(st.nodes["astra-final-review"]?.last_report?.verdict).toBe("FAIL");
    expect(r.next.kind).toBe("dispatch");
  });

  it("PASS and PASS+NOTES still walk to verify-head when status is done", async () => {
    for (const verdict of ["PASS", "PASS+NOTES"] as const) {
      const runId = verdict === "PASS" ? "run-final-pass" : "run-final-pass-notes";
      const { h, spec, key } = await bootFinalAttempt(runId, "bug-fix");
      await advance(h, runId, {
        type: "report",
        phase: "final",
        dispatch_key: key,
        report: { status: "done", verdict, summary: "通过" },
      }, { spec, gates: { accept: () => "ask_user" } });
      expect(readState(h, runId).cursor).toBe("verify-head");
    }
  });

  it("failed without verdict still stops", async () => {
    const { h, spec, key } = await bootFinalAttempt("run-fail-no-verdict", "bug-fix");
    const r = await advance(h, "run-fail-no-verdict", {
      type: "report",
      phase: "final",
      dispatch_key: key,
      report: { status: "failed", summary: "执行失败" },
    }, { spec });
    expect(readState(h, "run-fail-no-verdict").cursor).toBe("stopped");
    expect(r.next.kind).toBe("stop");
  });

  it("a repeated final does not rewind the cursor", async () => {
    const { h, spec, key } = await bootFinalAttempt("run-late-final", "bug-fix");
    await advance(h, "run-late-final", {
      type: "report",
      phase: "final",
      dispatch_key: key,
      report: { status: "failed", verdict: "FAIL", summary: "终审不通过" },
    }, { spec, gates: { accept: () => "ask_user" } });
    const after = readState(h, "run-late-final").cursor;
    await advance(h, "run-late-final", {
      type: "report",
      phase: "final",
      dispatch_key: key,
      report: { status: "done", verdict: "PASS", summary: "迟到" },
    }, { spec });
    expect(readState(h, "run-late-final").cursor).toBe(after);
    expect(readState(h, "run-late-final").late_reports.length).toBeGreaterThan(0);
  });
});

describe("prior FAIL cannot skip the next astra-final-review", () => {
  it("wait-ci ok dispatches astra-final-review:2 when last verdict is FAIL", async () => {
    const spec = PSTACK_GRAPHS["bug-fix"];
    const h = fakeHost({
      node: (method: string) => {
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "feat/x", head: HEAD } };
        return { ok: false, message: method };
      },
    });
    await createRun(h, {
      run_id: "run-re-review",
      spec_id: spec.id,
      profile_id: "sol",
      lead_harness: "codex",
      task_type: "bug-fix",
      entry: "wait-ci",
      goal: "修登录报错",
      worktree: WT,
      now: h.now(),
      scopeAllow: ["src/**"],
    });
    await withRun(h, "run-re-review", (raw) => {
      const s = raw as unknown as GraphRunState;
      s.team = { ready: true, team_id: "t1", lead_session_id: "lead" };
      s.cursor = "wait-ci";
      s.budget.astra_left = 3;
      s.nodes["wait-ci"] = { status: "active", attempts: 1 };
      s.nodes["astra-final-review"] = {
        status: "succeeded",
        attempts: 1,
        dispatch_state: "terminal",
        report_path: `${WT}/.keel/astra-final-review-1.md`,
        last_report: { status: "failed", verdict: "FAIL", summary: "旧 FAIL" },
      };
    });
    const r = await advance(h, "run-re-review", { type: "wait_done", on: "ok" }, { spec });
    expect(r.next.kind).toBe("dispatch");
    if (r.next.kind !== "dispatch") throw new Error("dispatch");
    expect(r.next.dispatch_key).toBe("run-re-review:astra-final-review:2");
    expect(readState(h, "run-re-review").cursor).toBe("astra-final-review");
  });
});

describe("astra-final-review always dispatches after wait-ci ok", () => {
  async function plantVerifyFinal(runId: string, implementFiles: string[], implementLines: number) {
    const spec = PSTACK_GRAPHS["bug-fix"];
    const h = fakeHost({
      node: (method: string) => {
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "feat/x", head: HEAD } };
        return { ok: false, message: method };
      },
    });
    await createRun(h, {
      run_id: runId,
      spec_id: spec.id,
      profile_id: "sol",
      lead_harness: "codex",
      task_type: "bug-fix",
      entry: "wait-ci",
      goal: "修登录报错",
      worktree: WT,
      now: h.now(),
      scopeAllow: ["src/**", "docs/**", "tests/**"],
    });
    const verifyKey = `${runId}:verify-same-surface:1`;
    await withRun(h, runId, (raw) => {
      const s = raw as unknown as GraphRunState;
      s.team = { ready: true, team_id: "t1", lead_session_id: "lead" };
      s.cursor = "verify-same-surface";
      s.budget.astra_left = 3;
      s.nodes["implement"] = {
        status: "succeeded",
        attempts: 1,
        last_report: {
          status: "done",
          summary: "写节点改动",
          files_changed: implementFiles,
          changed_lines: implementLines,
        },
      };
      s.nodes["verify-same-surface"] = {
        status: "active",
        attempts: 1,
        dispatch_key: verifyKey,
        dispatch_state: "running",
      };
    });
    await advance(h, runId, {
      type: "report",
      phase: "final",
      dispatch_key: verifyKey,
      report: {
        status: "done",
        summary: "只写了报告",
        files_changed: [".keel/verify-same-surface-1.md"],
        changed_lines: 20,
      },
    }, { spec });
    return { h, spec };
  }

  it("still dispatches astra-final-review when a write node changed source and the last node only wrote .keel", async () => {
    const { h, spec } = await plantVerifyFinal("run-keep-review", ["src/login.ts"], 508);
    await withRun(h, "run-keep-review", (raw) => {
      const s = raw as unknown as GraphRunState;
      s.status = "running";
      s.next = undefined;
      s.cursor = "wait-ci";
      s.nodes["wait-ci"] = { status: "active", attempts: 1 };
    });
    const r = await advance(h, "run-keep-review", { type: "wait_done", on: "ok" }, { spec });
    expect(r.next.kind).toBe("dispatch");
    if (r.next.kind !== "dispatch") throw new Error("dispatch");
    expect(r.next.dispatch_key).toBe("run-keep-review:astra-final-review:1");
    expect(readState(h, "run-keep-review").cursor).toBe("astra-final-review");
    expect(readState(h, "run-keep-review").nodes["astra-final-review"]?.status).not.toBe("skipped");
  });

  it("still dispatches astra-final-review when all write-node product files are docs/tests under the old line cap", async () => {
    const { h, spec } = await plantVerifyFinal("run-docs-review", ["docs/readme.md", "tests/a.test.ts"], 12);
    await withRun(h, "run-docs-review", (raw) => {
      const s = raw as unknown as GraphRunState;
      s.status = "running";
      s.next = undefined;
      s.cursor = "wait-ci";
      s.nodes["wait-ci"] = { status: "active", attempts: 1 };
    });
    const r = await advance(h, "run-docs-review", { type: "wait_done", on: "ok" }, { spec });
    expect(r.next.kind).toBe("dispatch");
    if (r.next.kind !== "dispatch") throw new Error("dispatch");
    expect(r.next.dispatch_key).toBe("run-docs-review:astra-final-review:1");
    expect(readState(h, "run-docs-review").cursor).toBe("astra-final-review");
    expect(readState(h, "run-docs-review").nodes["astra-final-review"]?.status).not.toBe("skipped");
  });
});

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const BASE_SHA = "c".repeat(40);
const profile = { lanes: [], routingPath: null, boardRepos: [], plansDir: null };

function prSnap(head: string) {
  return {
    ok: true,
    result: {
      preset: "personal",
      rule: LANE_PRESETS.personal,
      pr: {
        repo: "o/r", number: 34, url: "https://github.com/o/r/pull/34", title: "t", state: "OPEN",
        isDraft: false, headSha: head, headRef: "feat/x", baseRef: "main", mergeable: "MERGEABLE",
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

function verifyNode(method: string, localHead: string, prHead: string) {
  if (method === "git/changed-files") return { ok: true, result: { files: [] } };
  if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "feat/x", head: localHead } };
  if (method === "worktree/create") return { ok: true, result: { path: WT } };
  if (method === "pr/resolve") return { ok: true, result: { repo: "o/r", number: 34 } };
  if (method === "pr/snapshot") return prSnap(prHead);
  if (method === "pr/threads") return { ok: true, result: { threads: [] } };
  if (method === "git/base-sha") return { ok: true, result: { base_ref: "main", base_sha: BASE_SHA, fetched: true } };
  if (method === "git/patch-id") return { ok: true, result: { ok: true, patch_id: "patch-xyz" } };
  return { ok: false, message: method };
}

async function plantVerify(h: ReturnType<typeof fakeHost>, specId: "bug-fix" | "feature" | "refactoring", localHead: string) {
  const nodeId = specId === "refactoring" ? "equivalence" : "verify-same-surface";
  const started: any = await runTool(makeContext(h, "c1", profile), "keel_run", {
    goal: specId === "feature" ? "新增登录功能" : specId === "refactoring" ? "重构登录模块" : "修登录报错",
    repo_dir: "/repo",
    lead: "codex",
    playbook: specId,
    scope: ["src/**"],
  });
  const runId = started.result.run_id as string;
  const key = `${runId}:${nodeId}:1`;
  await withRun(h, runId, (raw) => {
    const s = raw as unknown as GraphRunState;
    s.pr = 34;
    s.repo = "o/r";
    s.gh_repo = "o/r";
    s.worktree = WT;
    s.team = { ready: true, team_id: "t1", lead_session_id: "lead" };
    s.cursor = nodeId;
    s.pr_binding = { repo: "o/r", number: 34, base_ref: "main", base_sha: BASE_SHA, head_sha: HEAD_A };
    s.nodes[nodeId] = {
      status: "active",
      attempts: 1,
      dispatch_key: key,
      dispatch_state: "running",
      planned_params: {
        label: "keel-v-1",
        role: "keel-worker",
        agent: "pi",
        model: "grok-4.6",
        provider_id: "art-cindy",
        initial_task: "v",
        writes: true,
        fallbacks: [],
        route_index: 0,
        scopeAllow: ["src/**"],
        start_sha: localHead,
      },
    };
  });
  return { runId, key, nodeId };
}

describe("local verify binds worktree HEAD not the remote PR head", () => {
  it.each(["bug-fix", "feature", "refactoring"] as const)("%s local B vs remote A advances off the verify node", async (specId) => {
    const h = fakeHost({ node: (method: string) => verifyNode(method, HEAD_B, HEAD_A) });
    const { runId, key, nodeId } = await plantVerify(h, specId, HEAD_B);
    const r: any = await runTool(makeContext(h, "c2", profile), "keel_report", {
      run_id: runId,
      phase: "final",
      dispatch_key: key,
      inline_report: {
        status: "done",
        summary: "本地验证通过",
        ran: [{ cmd: "npm test", exit_code: 0, tests_passed: 1 }],
        files_changed: ["src/login.ts"],
        functions_touched: ["login"],
        changed_lines: 12,
        head_sha: HEAD_B,
      },
    });
    expect(r.ok, r.message).toBe(true);
    const st = JSON.parse(h.files.get(graphStatePath(runId))!) as GraphRunState;
    expect(st.nodes[nodeId]?.last_report?.head_matches).toBe(true);
    expect(st.verdict).toBeUndefined();
    expect(st.cursor).not.toBe(nodeId);
    expect(st.cursor).not.toBe("stopped");
    if (specId === "bug-fix" || specId === "refactoring") {
      expect(st.cursor).toBe("open-pr");
      expect(r.result.next.kind).toBe("wait");
      expect(r.result.next.call.tool).toBe("pr_open");
    }
  });

  it("missing local HEAD writes head_matches false and does not fall back to PR A", async () => {
    const h = fakeHost({
      node: (method: string, params: Record<string, unknown> = {}) => {
        if (method === "git/state" && params.repo_dir === WT) return { ok: false, message: "no git" };
        return verifyNode(method, HEAD_B, HEAD_A);
      },
    });
    const { runId, key, nodeId } = await plantVerify(h, "bug-fix", HEAD_B);
    await runTool(makeContext(h, "c2", profile), "keel_report", {
      run_id: runId,
      phase: "final",
      dispatch_key: key,
      inline_report: {
        status: "done",
        summary: "ok",
        ran: [{ cmd: "npm test", exit_code: 0, tests_passed: 1 }],
        files_changed: ["src/login.ts"],
        head_sha: HEAD_B,
      },
    });
    const st = JSON.parse(h.files.get(graphStatePath(runId))!) as GraphRunState;
    expect(st.nodes[nodeId]?.last_report?.head_matches).toBe(false);
    expect(st.cursor).toBe(nodeId);
  });
});

describe("FAIL then small verify report still re-runs final review", () => {
  it("FAIL then a later .keel-only verify still re-runs final review", async () => {
    const h = fakeHost({ node: (method: string) => verifyNode(method, HEAD_B, HEAD_B) });
    const { runId, key } = await plantVerify(h, "bug-fix", HEAD_B);
    await withRun(h, runId, (raw) => {
      const s = raw as unknown as GraphRunState;
      s.budget.astra_left = 3;
      s.nodes["astra-final-review"] = {
        status: "succeeded",
        attempts: 1,
        dispatch_state: "terminal",
        report_path: `${WT}/.keel/astra-final-review-1.md`,
        last_report: { status: "failed", verdict: "FAIL", summary: "旧 FAIL", head_sha: HEAD_A },
      };
    });
    await runTool(makeContext(h, "c2", profile), "keel_report", {
      run_id: runId,
      phase: "final",
      dispatch_key: key,
      inline_report: {
        status: "done",
        summary: "只写了报告",
        ran: [{ cmd: "npm test", exit_code: 0, tests_passed: 1 }],
        files_changed: [".keel/verify-same-surface-2.md"],
        changed_lines: 20,
        head_sha: HEAD_B,
      },
    });
    const afterVerify = JSON.parse(h.files.get(graphStatePath(runId))!) as GraphRunState;
    expect(afterVerify.cursor).toBe("open-pr");
    const opened: any = await runTool(makeContext(h, "c3", profile), "keel_wait", { run_id: runId });
    expect(opened.ok, opened.message).toBe(true);
    const waited: any = await runTool(makeContext(h, "c4", profile), "keel_wait", { run_id: runId });
    expect(waited.ok, waited.message).toBe(true);
    expect(waited.result.next.kind).toBe("dispatch");
    expect(waited.result.next.dispatch_key).toBe(`${runId}:astra-final-review:2`);
    const st = JSON.parse(h.files.get(graphStatePath(runId))!) as GraphRunState;
    expect(st.cursor).toBe("astra-final-review");
    expect(st.nodes["astra-final-review"]?.attempts).toBe(2);
  });

  it("pr graph FAIL revises to fix-ci then open-pr reuses the PR, wait-ci, astra-final-review:2", async () => {
    const spec = PSTACK_GRAPHS.pr;
    const runId = "run-pr-fixci-open";
    const h = fakeHost({
      node: (method: string) => verifyNode(method, HEAD_B, HEAD_B),
    });
    await createRun(h, {
      run_id: runId,
      spec_id: spec.id,
      profile_id: "sol",
      lead_harness: "codex",
      task_type: "pr",
      entry: "g-accept",
      goal: "修登录报错",
      worktree: WT,
      now: h.now(),
      scopeAllow: ["src/**"],
    });
    await withRun(h, runId, (raw) => {
      const s = raw as unknown as GraphRunState;
      s.team = { ready: true, team_id: "t1", lead_session_id: "lead" };
      s.cursor = "g-accept";
      s.pr = 34;
      s.repo = "o/r";
      s.gh_repo = "o/r";
      s.budget.astra_left = 3;
      s.pr_binding = { repo: "o/r", number: 34, base_ref: "main", base_sha: BASE_SHA, head_sha: HEAD_A };
      s.nodes["astra-final-review"] = {
        status: "succeeded",
        attempts: 1,
        dispatch_state: "terminal",
        report_path: `${WT}/.keel/astra-final-review-1.md`,
        last_report: { status: "done", summary: "终审不通过", verdict: "FAIL" },
      };
      s.nodes["g-accept"] = { status: "pending", attempts: 0 };
    });
    const failed = await advance(h, runId, { type: "tick" }, { spec });
    expect(readState(h, runId).cursor).toBe("fix-ci");
    expect(failed.next.kind).toBe("dispatch");
    if (failed.next.kind !== "dispatch") throw new Error("dispatch");
    const fixKey = failed.next.dispatch_key;
    await withRun(h, runId, (raw) => {
      const s = raw as unknown as GraphRunState;
      const node = s.nodes["fix-ci"];
      if (node) node.dispatch_state = "running";
    });
    const fixed = await advance(h, runId, {
      type: "report",
      phase: "final",
      dispatch_key: fixKey,
      report: { status: "done", summary: "修了 CI", head_sha: HEAD_B, files_changed: ["src/ci.ts"] },
    }, { spec });
    expect(readState(h, runId).cursor).toBe("open-pr");
    expect(fixed.next.kind).toBe("wait");
    if (fixed.next.kind !== "wait") throw new Error("wait");
    if (fixed.next.call.tool !== "pr_open") throw new Error("pr_open");
    expect(fixed.next.call.args.push).toBe(true);
    const opened: any = await runTool(makeContext(h, "c-open", profile), "keel_wait", { run_id: runId });
    expect(opened.ok, opened.message).toBe(true);
    const afterOpen = JSON.parse(h.files.get(graphStatePath(runId))!) as GraphRunState;
    expect(afterOpen.cursor).toBe("wait-ci");
    expect(afterOpen.pr).toBe(34);
    const waited: any = await runTool(makeContext(h, "c-wait", profile), "keel_wait", { run_id: runId });
    expect(waited.ok, waited.message).toBe(true);
    expect(waited.result.next.kind).toBe("dispatch");
    expect(waited.result.next.dispatch_key).toBe(`${runId}:astra-final-review:2`);
    expect(readState(h, runId).cursor).toBe("astra-final-review");
    expect(readState(h, runId).nodes["astra-final-review"]?.attempts).toBe(2);
  });

  it("triage-threads success walks to open-pr then wait-ci", async () => {
    const spec = PSTACK_GRAPHS.pr;
    const runId = "run-pr-threads-open";
    const h = fakeHost({
      node: (method: string) => verifyNode(method, HEAD_B, HEAD_B),
    });
    await createRun(h, {
      run_id: runId,
      spec_id: spec.id,
      profile_id: "sol",
      lead_harness: "codex",
      task_type: "pr",
      entry: "triage-threads",
      goal: "修登录报错",
      worktree: WT,
      now: h.now(),
      scopeAllow: ["src/**"],
    });
    await withRun(h, runId, (raw) => {
      const s = raw as unknown as GraphRunState;
      s.team = { ready: true, team_id: "t1", lead_session_id: "lead" };
      s.cursor = "triage-threads";
      s.pr = 34;
      s.repo = "o/r";
      s.gh_repo = "o/r";
      s.budget.astra_left = 3;
      s.pr_binding = { repo: "o/r", number: 34, base_ref: "main", base_sha: BASE_SHA, head_sha: HEAD_A };
      s.nodes["open-pr"] = { status: "succeeded", attempts: 1, dispatch_state: "terminal" };
      s.nodes["wait-ci"] = { status: "succeeded", attempts: 1, dispatch_state: "terminal" };
      s.nodes["astra-final-review"] = {
        status: "succeeded",
        attempts: 1,
        dispatch_state: "terminal",
        report_path: `${WT}/.keel/astra-final-review-1.md`,
        last_report: { status: "done", summary: "终审通过", verdict: "PASS" },
      };
    });
    const first = await advance(h, runId, { type: "tick" }, { spec });
    expect(first.next.kind).toBe("dispatch");
    if (first.next.kind !== "dispatch") throw new Error("dispatch");
    expect(first.next.dispatch_key).toBe(`${runId}:triage-threads:1`);
    const task = first.next.create_worker?.initial_task ?? "";
    expect(task).toContain("先读这些已完成报告再动手");
    expect(task).toContain(`${WT}/.keel/astra-final-review-1.md`);
    expect(task).not.toContain(`${WT}/.keel/open-pr-1.md`);
    expect(task).not.toContain(`${WT}/.keel/wait-ci-1.md`);
    await withRun(h, runId, (raw) => {
      const s = raw as unknown as GraphRunState;
      const node = s.nodes["triage-threads"];
      if (node) node.dispatch_state = "running";
    });
    const fixed = await advance(h, runId, {
      type: "report",
      phase: "final",
      dispatch_key: first.next.dispatch_key,
      report: { status: "done", summary: "回了评审", head_sha: HEAD_B, files_changed: ["src/review.ts"] },
    }, { spec });
    expect(readState(h, runId).cursor).toBe("open-pr");
    expect(fixed.next.kind).toBe("wait");
    if (fixed.next.kind !== "wait") throw new Error("wait");
    if (fixed.next.call.tool !== "pr_open") throw new Error("pr_open");
    expect(fixed.next.call.args.push).toBe(true);
    const opened: any = await runTool(makeContext(h, "c-open-threads", profile), "keel_wait", { run_id: runId });
    expect(opened.ok, opened.message).toBe(true);
    expect(readState(h, runId).cursor).toBe("wait-ci");
  });

  it("pr graph from entry keeps open-pr history through CI repair then final FAIL and still re-reviews", async () => {
    const spec = PSTACK_GRAPHS.pr;
    const runId = "run-pr-entry-ci-then-final";
    const h = fakeHost({
      node: (method: string) => verifyNode(method, HEAD_B, HEAD_B),
    });
    await createRun(h, {
      run_id: runId,
      spec_id: spec.id,
      profile_id: "sol",
      lead_harness: "codex",
      task_type: "pr",
      entry: spec.entry,
      goal: "修登录报错",
      worktree: WT,
      now: h.now(),
      scopeAllow: ["src/**"],
    });
    await withRun(h, runId, (raw) => {
      const s = raw as unknown as GraphRunState;
      s.team = { ready: true, team_id: "t1", lead_session_id: "lead" };
      s.budget.astra_left = 3;
    });
    let result = await advance(h, runId, { type: "tick" }, { spec });
    expect(readState(h, runId).cursor).toBe("open-pr");
    expect(readState(h, runId).nodes["open-pr"]?.attempts).toBe(1);
    expect(result.next.kind).toBe("wait");
    if (result.next.kind !== "wait") throw new Error("wait");
    expect(result.next.call.tool).toBe("pr_open");

    result = await advance(h, runId, { type: "wait_done", on: "ok" }, { spec });
    expect(readState(h, runId).cursor).toBe("wait-ci");
    result = await advance(h, runId, { type: "wait_done", on: "ci_red" }, { spec });
    expect(readState(h, runId).cursor).toBe("ci-rerun-once");
    result = await advance(h, runId, { type: "wait_done", on: "fail" }, { spec });
    expect(readState(h, runId).cursor).toBe("fix-ci");
    expect(result.next.kind).toBe("dispatch");
    if (result.next.kind !== "dispatch") throw new Error("dispatch");
    expect(result.next.dispatch_key).toBe(`${runId}:fix-ci:1`);

    await withRun(h, runId, (raw) => {
      const node = (raw as unknown as GraphRunState).nodes["fix-ci"];
      if (node) node.dispatch_state = "running";
    });
    result = await advance(h, runId, {
      type: "report",
      phase: "final",
      dispatch_key: result.next.dispatch_key,
      report: { status: "done", summary: "修了 CI", head_sha: HEAD_B, files_changed: ["src/ci.ts"] },
    }, { spec });
    expect(readState(h, runId).cursor).toBe("open-pr");
    expect(readState(h, runId).nodes["open-pr"]?.attempts).toBe(2);
    expect(result.next.kind).toBe("wait");
    if (result.next.kind !== "wait") throw new Error("wait");
    if (result.next.call.tool !== "pr_open") throw new Error("pr_open");
    expect(result.next.call.args.push).toBe(true);

    result = await advance(h, runId, { type: "wait_done", on: "ok" }, { spec });
    expect(readState(h, runId).cursor).toBe("wait-ci");
    result = await advance(h, runId, { type: "wait_done", on: "ok" }, { spec });
    expect(readState(h, runId).cursor).toBe("astra-final-review");
    expect(result.next.kind).toBe("dispatch");
    if (result.next.kind !== "dispatch") throw new Error("dispatch");
    expect(result.next.dispatch_key).toBe(`${runId}:astra-final-review:1`);

    await withRun(h, runId, (raw) => {
      const node = (raw as unknown as GraphRunState).nodes["astra-final-review"];
      if (node) node.dispatch_state = "running";
    });
    result = await advance(h, runId, {
      type: "report",
      phase: "final",
      dispatch_key: result.next.dispatch_key,
      report: { status: "done", summary: "P1 found", verdict: "FAIL" },
    }, { spec });
    expect(readState(h, runId).cursor).toBe("fix-ci");
    expect(result.next.kind).toBe("dispatch");
    if (result.next.kind !== "dispatch") throw new Error("dispatch");
    expect(result.next.dispatch_key).toBe(`${runId}:fix-ci:2`);

    await withRun(h, runId, (raw) => {
      const node = (raw as unknown as GraphRunState).nodes["fix-ci"];
      if (node) node.dispatch_state = "running";
    });
    result = await advance(h, runId, {
      type: "report",
      phase: "final",
      dispatch_key: result.next.dispatch_key,
      report: { status: "done", summary: "P1 repaired", head_sha: HEAD_B, files_changed: ["src/ci.ts"] },
    }, { spec });
    expect(readState(h, runId).cursor).toBe("open-pr");
    expect(readState(h, runId).nodes["open-pr"]?.attempts).toBe(3);
    expect(result.next.kind).toBe("wait");
    if (result.next.kind !== "wait") throw new Error("wait");
    if (result.next.call.tool !== "pr_open") throw new Error("pr_open");
    expect(result.next.call.args.push).toBe(true);

    const opened: any = await runTool(makeContext(h, "c-open-hist", profile), "keel_wait", { run_id: runId });
    expect(opened.ok, opened.message).toBe(true);
    expect(readState(h, runId).cursor).toBe("wait-ci");
    expect(readState(h, runId).pr).toBe(34);
    const waited: any = await runTool(makeContext(h, "c-wait-hist", profile), "keel_wait", { run_id: runId });
    expect(waited.ok, waited.message).toBe(true);
    expect(waited.result.next.kind).toBe("dispatch");
    expect(waited.result.next.dispatch_key).toBe(`${runId}:astra-final-review:2`);
    expect(readState(h, runId).cursor).toBe("astra-final-review");
    expect(readState(h, runId).nodes["astra-final-review"]?.attempts).toBe(2);
  });
});
