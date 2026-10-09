import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { makeContext } from "../../src/main/context.ts";
import { runTool } from "../../src/main/dispatch.ts";
import { normalizeSc } from "../../src/main/tools/keel.ts";
import { isChangeGraphDone } from "../../src/main/graph/done.ts";
import { advance, createRun } from "../../src/main/graph/interpreter.ts";
import type { GraphRunState } from "../../src/main/graph/state.ts";
import { graphStatePath, withRun } from "../../src/main/store/runs.ts";
import { mapOrchLevel } from "../../src/main/graph/verdict.ts";
import * as env from "../../src/node/env.ts";
import { prOpen as nodePrOpen } from "../../src/node/pr/actions.ts";
import { PSTACK_GRAPHS } from "../../src/shared/graph/pstack.ts";
import { EMPTY_PROFILE, LANE_PRESETS } from "../../src/shared/types.ts";
import { addWorktree, cleanupRepos, git, makeRepo } from "../e2e/helpers.ts";
import { fakeHost } from "../helpers/fakeHost.ts";

const profile = { lanes: [], routingPath: null, boardRepos: [], plansDir: null };
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

afterEach(() => {
  vi.restoreAllMocks();
  cleanupRepos();
});

function prSnap() {
  return {
    ok: true,
    result: {
      preset: "personal",
      rule: LANE_PRESETS.personal,
      pr: {
        repo: "o/r", number: 1, url: "https://github.com/o/r/pull/1", title: "t", state: "OPEN",
        isDraft: false, headSha: HEAD, headRef: "feat/x", baseRef: "main",
        mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", labels: [],
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

describe("R26-01 SC live-ui surface is required for done", () => {
  it("keel_run keeps min_level and infers it from a UI verify command", async () => {
    const h = fakeHost({
      node: (method: string) => {
        if (method === "git/changed-files") return { ok: true, result: { files: [] } };
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "main", head: HEAD, gh_repo: "o/r" } };
        if (method === "worktree/create") return { ok: true, result: { path: "/repo/.worktrees/x" } };
        return { ok: false, message: method };
      },
    });
    const named: any = await runTool(makeContext(h, "c1", profile), "keel_run", {
      goal: "修登录按钮并验证实际界面", repo_dir: "/repo", lead: "codex", playbook: "bug-fix",
      sc: [{ id: "SC-1", text: "实际点击按钮成功", verify: "npx vitest run", minLevel: "live-ui-verified" }],
      scope: ["src/**"],
    });
    expect(named.ok).toBe(true);
    const namedState = JSON.parse(h.files.get(graphStatePath(named.result.run_id))!) as GraphRunState;
    expect(namedState.sc[0]?.min_level).toBe("live-ui-verified");

    const inferred: any = await runTool(makeContext(h, "c2", profile), "keel_run", {
      goal: "修登录按钮并验证实际界面", repo_dir: "/repo", lead: "codex", playbook: "bug-fix",
      sc: [{ id: "SC-1", text: "实际点击按钮成功", verify: "npx playwright test" }],
      scope: ["src/**"],
    });
    expect(inferred.ok).toBe(true);
    const inferredState = JSON.parse(h.files.get(graphStatePath(inferred.result.run_id))!) as GraphRunState;
    expect(inferredState.sc[0]?.min_level).toBe("live-ui-verified");
  });

  it("unit-test-verified cannot satisfy a live-ui SC; UI runner + ui_evidence + tests_passed≥1 can", () => {
    const base = {
      pr_status: "report_mergeable",
      author_families: ["grok"] as const,
      current: { head_sha: "head", base_sha: "base", patch_id: "pid", patch_ok: true },
      openHumanGates: 0,
    };
    const unit = {
      repo: "acme/app", pr: 3, base_ref: "main", base_sha: "base", head_sha: "head", patch_id: "pid",
      level: "unit-test-verified" as const, surface: "unit-test" as const,
      by_route: { agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy" }, by_family: "gpt",
    };
    const blocked = isChangeGraphDone({
      ...base,
      sc: [{ id: "SC-1", hasEvidence: true, minLevel: "live-ui-verified" }],
      verdict: unit,
    });
    expect(blocked.done).toBe(false);
    expect(blocked.missing.join("；")).toMatch(/live-ui-verified/);

    const liveLevel = mapOrchLevel({
      verdict: "PASS",
      ran: [{ cmd: "npx playwright test", exit_code: 0, tests_passed: 1 }],
      ui_evidence: ["shots/click.png"],
      surface: "live-ui",
    });
    expect(liveLevel).toBe("live-ui-verified");
    const ok = isChangeGraphDone({
      ...base,
      sc: [{ id: "SC-1", hasEvidence: true, minLevel: "live-ui-verified" }],
      verdict: { ...unit, level: liveLevel, surface: "live-ui" },
    });
    expect(ok.done).toBe(true);
  });
});

describe("R26-02 late attempt must not write ledger or commit status", () => {
  it("attempt 2 failed: late attempt 1 PASS does not write ledger/status and keeps verifier-failed", async () => {
    const host = fakeHost({
      node: (method: string) => {
        if (method === "git/changed-files") return { ok: true, result: { files: [] } };
        if (method === "git/state") return { ok: true, result: { head: HEAD, root: "/repo", branch: "feat/x" } };
        if (method === "pr/snapshot") return prSnap();
        if (method === "pr/threads") return { ok: true, result: { threads: [] } };
        if (method === "git/base-sha") return { ok: true, result: { base_sha: BASE } };
        if (method === "git/patch-id") return { ok: true, result: { ok: true, patch_id: "patch" } };
        if (method === "orch/run") return { ok: true, result: {} };
        if (method === "gh/commit-status") return { ok: true, result: { ok: true } };
        return { ok: false, message: method };
      },
    });
    await createRun(host, {
      run_id: "late-verifier", spec_id: "bug-fix", task_type: "bug-fix", profile_id: "sol",
      lead_harness: "codex", entry: "verify-head", goal: "修复", worktree: "/repo/.worktrees/test",
      pr: 1, repo: "o/r", gh_repo: "o/r", now: host.now(),
    });
    await withRun(host, "late-verifier", (raw) => {
      const s = raw as unknown as GraphRunState;
      s.team = { ready: true, team_id: "t1" };
      s.author_families = ["grok"];
      s.status = "await_sol";
      s.next = { kind: "decide", gate_id: "done", question: "当前验证失败", options: ["stop"] };
      s.verdict = {
        head: HEAD, base_sha: BASE, patch_id: "patch", level: "verifier-failed",
        by_route: { agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy" }, by_family: "gpt",
      };
      s.nodes["verify-head"] = {
        status: "failed", attempts: 2, dispatch_key: "late-verifier:verify-head:2",
        dispatch_state: "terminal", started_at: host.now(), dispatch_state_at: host.now(),
        planned_params: {
          label: "ver2", role: "keel-verifier", agent: "codex", model: "gpt-6-luna",
          provider_id: "art-cindy", initial_task: "verify", writes: false, fallbacks: [], route_index: 0,
        },
        actual_route: { agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy" },
      };
    });
    const ctx = makeContext(host, "late-final", { ...EMPTY_PROFILE, lanes: [{ repo: "o/r", preset: "personal", verifyCheck: "keel/verifier" }] });
    const result: any = await runTool(ctx, "keel_report", {
      run_id: "late-verifier",
      phase: "final",
      dispatch_key: "late-verifier:verify-head:1",
      inline_report: {
        status: "done", summary: "old attempt PASS", head_sha: HEAD, verdict: "PASS",
        files_changed: [], ran: [{ cmd: "npx vitest run", exit_code: 0, tests_passed: 1 }],
      },
    });
    const state = JSON.parse(host.files.get("runs/late-verifier/graph-state.json")!) as GraphRunState;
    expect(result.ok).toBe(true);
    expect(state.verdict?.level).toBe("verifier-failed");
    expect(state.late_reports).toHaveLength(1);
    expect(host.nodeCalls.filter((c) => c.method === "gh/commit-status")).toHaveLength(0);
    expect(host.nodeCalls.filter((c) => c.method === "orch/run" && (c.params as { op?: string }).op === "ledger.record")).toHaveLength(0);
  });
});

describe("R26-03 open-pr next pushes a branch with no upstream", () => {
  it("next.call.args has push:true and pr_open does not reject NOT_PUSHED against a local bare remote", async () => {
    const host = fakeHost();
    const spec = PSTACK_GRAPHS["bug-fix"];
    const { dir } = makeRepo();
    const wt = addWorktree(dir, "probe-new");
    mkdirBareAndMapGithub(dir);
    await createRun(host, {
      run_id: "probe-open", spec_id: spec.id, task_type: "bug-fix", profile_id: "sol",
      lead_harness: "codex", entry: "open-pr", goal: "修登录报错", worktree: wt, now: host.now(),
    });
    const { next } = await advance(host, "probe-open", { type: "tick" }, { spec });
    expect(next.kind).toBe("wait");
    if (next.kind !== "wait") throw new Error("wait");
    expect(next.call.tool).toBe("pr_open");
    const args = next.call.args as Record<string, unknown>;
    expect(args.push).toBe(true);
    vi.spyOn(env, "ghJson").mockImplementation(async (args: readonly string[]) => {
      if (args[0] === "repo" && args[1] === "view") return { defaultBranchRef: { name: "main" } };
      if (args[0] === "pr" && args[1] === "list") return [];
      throw new Error(`unexpected ghJson ${args.join(" ")}`);
    });
    vi.spyOn(env, "gh").mockResolvedValue("https://github.com/acme/app/pull/42\n");
    const opened = await nodePrOpen(EMPTY_PROFILE, {
      repo_dir: String(args.repo_dir),
      title: String(args.title ?? "fix: login"),
      sections: (args.sections as Record<string, string> | string) ?? "body",
      push: args.push === true,
    });
    expect(opened.number).toBe(42);
    expect(git(wt, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}").trim()).toMatch(/origin\//);
  });
});

describe("R26-R04 invalid SC is rejected, not dropped", () => {
  it("keel_run rejects missing text/id and illegal min_level with INVALID_SC", async () => {
    const h = fakeHost({
      node: (method: string) => {
        if (method === "git/changed-files") return { ok: true, result: { files: [] } };
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "main", head: HEAD, gh_repo: "o/r" } };
        if (method === "worktree/create") return { ok: true, result: { path: "/repo/.worktrees/x" } };
        return { ok: false, message: method };
      },
    });
    const missingText: any = await runTool(makeContext(h, "c1", profile), "keel_run", {
      goal: "修登录报错", repo_dir: "/repo", lead: "codex", playbook: "bug-fix",
      sc: [{ id: "SC-2", min_level: "live-ui-verified", verify: "npx playwright test" }],
    });
    expect(missingText.ok).toBe(false);
    expect(missingText.errorCode).toBe("INVALID_SC");
    expect(missingText.message).toMatch(/sc\[0\]/);
    expect(missingText.message).toMatch(/text/);
    expect(missingText.data).toMatchObject({ index: 0, missing: expect.arrayContaining(["text"]) });
    expect([...h.files.keys()].some((k) => k.includes("graph-state"))).toBe(false);

    const missingId: any = await runTool(makeContext(h, "c2", profile), "keel_run", {
      goal: "修登录报错", repo_dir: "/repo", lead: "codex", playbook: "bug-fix",
      sc: [{ text: "点击成功", min_level: "live-ui-verified", verify: "npx playwright test" }],
    });
    expect(missingId.ok).toBe(false);
    expect(missingId.errorCode).toBe("INVALID_SC");
    expect(missingId.data).toMatchObject({ index: 0, missing: expect.arrayContaining(["id"]) });

    const badLevel: any = await runTool(makeContext(h, "c3", profile), "keel_run", {
      goal: "修登录报错", repo_dir: "/repo", lead: "codex", playbook: "bug-fix",
      sc: [{ id: "SC-1", text: "点击成功", min_level: "not-a-level", verify: "npx vitest run" }],
    });
    expect(badLevel.ok).toBe(false);
    expect(badLevel.errorCode).toBe("INVALID_SC");
    expect(badLevel.data).toMatchObject({ index: 0, missing: expect.arrayContaining(["min_level"]) });

    const manifest = JSON.parse(readFileSync("plugin/ghost.json", "utf8"));
    const items = manifest.tools.find((t: { name: string }) => t.name === "keel_run").parameters.properties.sc.items;
    expect(items.required).toEqual(expect.arrayContaining(["id", "text"]));
    expect(items.properties.min_level.enum).toEqual(["live-ui-verified", "unit-test-verified", "type-check-only"]);
  });
});

describe("R26-R05 quoted UI verify still implies live-ui", () => {
  it("quoted, piped, and env-prefixed UI commands infer live-ui; vitest does not", () => {
    const ui = [
      'npx playwright test --project="chromium"',
      "npx playwright test | tee log.txt",
      "CI=1 npx playwright test",
      "pnpm exec cypress run --spec 'a.js'",
    ];
    for (const verify of ui) {
      expect(normalizeSc([{ id: "SC-1", text: "实际界面验收", verify }])[0]?.min_level, verify).toBe("live-ui-verified");
    }
    expect(normalizeSc([{ id: "SC-1", text: "单测", verify: "npx vitest run" }])[0]?.min_level).toBeUndefined();
  });
});

describe("R26-R06 late final cannot overwrite hard gate after concurrent retry", () => {
  it("blocked git/base-sha then attempt2 FAIL: only failure is written externally", async () => {
    let release!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>((r) => { release = r; });
    const atBase = new Promise<void>((r) => { reached = r; });
    let baseCalls = 0;
    const host = fakeHost({
      node: async (method: string) => {
        if (method === "git/changed-files") return { ok: true, result: { files: [] } };
        if (method === "git/state") return { ok: true, result: { head: HEAD, root: "/repo", branch: "feat/x" } };
        if (method === "pr/snapshot") return prSnap();
        if (method === "pr/threads") return { ok: true, result: { threads: [] } };
        if (method === "git/base-sha") {
          if (++baseCalls === 1) { reached(); await paused; }
          return { ok: true, result: { base_sha: BASE } };
        }
        if (method === "git/patch-id") return { ok: true, result: { ok: true, patch_id: "patch" } };
        if (method === "orch/run" || method === "gh/commit-status") return { ok: true, result: {} };
        return { ok: false, message: method };
      },
    });
    await createRun(host, {
      run_id: "race-verifier", spec_id: "bug-fix", task_type: "bug-fix", profile_id: "sol",
      lead_harness: "codex", entry: "verify-head", goal: "修复", worktree: "/repo/wt", pr: 1, repo: "o/r", now: host.now(),
    });
    await withRun(host, "race-verifier", (raw) => {
      const s = raw as unknown as GraphRunState;
      s.status = "running";
      s.next = { kind: "wait", call: { tool: "keel_wait", args: { run_id: "race-verifier" } } };
      s.team = { ready: true, team_id: "t1" };
      s.author_families = ["grok"];
      s.nodes["verify-head"] = {
        status: "active", attempts: 1, dispatch_key: "race-verifier:verify-head:1", dispatch_state: "running",
        started_at: host.now() - 40 * 60_000 + 1000, dispatch_state_at: host.now() - 40 * 60_000 + 1000,
        worker_id: "w1", worker_label: "ver1", team_id: "t1",
        planned_params: {
          label: "ver1", role: "keel-verifier", agent: "codex", model: "gpt-6-luna",
          provider_id: "art-cindy", initial_task: "v", writes: false, fallbacks: [], route_index: 0,
        },
        actual_route: { agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy" },
      };
    });
    const ctx = { ...EMPTY_PROFILE, lanes: [{ repo: "o/r", preset: "personal" as const, verifyCheck: "keel/verifier" }] };
    const pending = runTool(makeContext(host, "race", ctx), "keel_report", {
      run_id: "race-verifier", phase: "final", dispatch_key: "race-verifier:verify-head:1",
      inline_report: { status: "done", summary: "old", verdict: "PASS", head_sha: HEAD, ran: [{ cmd: "npx vitest run", exit_code: 0, tests_passed: 1 }] },
    });
    await atBase;
    host.clock.t += 2000;
    const opts = { gates: { retry: () => "retry" as const } };
    const timed = await advance(host, "race-verifier", { type: "tick" }, opts);
    expect(timed.next).toMatchObject({ kind: "recover", action: "diagnose" });
    await advance(host, "race-verifier", { type: "report", phase: "recover", dispatch_key: "race-verifier:verify-head:1", action: "diagnose", action_result: { running: true } }, opts);
    await advance(host, "race-verifier", { type: "report", phase: "recover", dispatch_key: "race-verifier:verify-head:1", action: "archive", action_result: { ok: true } }, opts);
    const retry = await advance(host, "race-verifier", { type: "report", phase: "recover", dispatch_key: "race-verifier:verify-head:1", action: "verify_stopped", action_result: { ok: true, complete: true, team_id: "t1", workers: [] } }, opts);
    expect(retry.next).toMatchObject({ kind: "dispatch", dispatch_key: "race-verifier:verify-head:2" });
    const accepted: any = await runTool(makeContext(host, "new-accepted"), "keel_report", {
      run_id: "race-verifier", phase: "accepted", dispatch_key: "race-verifier:verify-head:2",
      worker_id: "w2", worker_session_id: "ws2", dispatch_outcome: { dispatched: true, wakeKind: "immediate" },
    });
    expect(accepted.ok).toBe(true);
    await runTool(makeContext(host, "new-final", ctx), "keel_report", {
      run_id: "race-verifier", phase: "final", dispatch_key: "race-verifier:verify-head:2",
      inline_report: { status: "failed", summary: "new attempt failed", verdict: "FAIL", head_sha: HEAD, ran: [{ cmd: "npx vitest run", exit_code: 1, tests_passed: 0 }] },
    });
    release();
    const out: any = await pending;
    expect(out.ok).toBe(true);
    const state = JSON.parse(host.files.get("runs/race-verifier/graph-state.json")!) as GraphRunState;
    expect(state.verdict?.level).toBe("verifier-failed");
    expect(state.late_reports).toHaveLength(1);
    const writes = host.nodeCalls.filter((c) => c.method === "gh/commit-status" || (c.method === "orch/run" && (c.params as { op?: string }).op === "ledger.record"));
    expect(writes.filter((c) => c.method === "gh/commit-status").map((c) => (c.params as { state?: string }).state)).toEqual(["failure"]);
    expect(writes.filter((c) => c.method === "orch/run").map((c) => (c.params as { args?: { verdict?: string } }).args?.verdict)).toEqual(["verifier-failed"]);
  });
});

function mkdirBareAndMapGithub(repoDir: string): string {
  const bare = mkdtempSync(resolve("_tmp/test-runs/bare-"));
  git(bare, "init", "--bare", "-q");
  git(repoDir, "remote", "set-url", "--push", "origin", bare);
  return bare;
}
