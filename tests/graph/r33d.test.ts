// PR #33 delta review: R33D-01 pstack_start scope, R33D-02 investigation report delivery, R33D-03 read-only nodes changing files.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeContext } from "../../src/main/context.ts";
import { runTool } from "../../src/main/dispatch.ts";
import { buildBrief } from "../../src/main/graph/brief.ts";
import { advance, createRun } from "../../src/main/graph/interpreter.ts";
import { PSTACK_GRAPHS } from "../../src/shared/graph/pstack.ts";
import type { GraphRunState } from "../../src/main/graph/state.ts";
import { graphStatePath, withRun } from "../../src/main/store/runs.ts";
import { fakeHost } from "../helpers/fakeHost.ts";

const profile = { lanes: [], routingPath: null, boardRepos: [], plansDir: null };

describe("R33D-01 pstack_start can pass scope", () => {
  it("declares scope in the public schema and starts a writing run with it", async () => {
    const manifest = JSON.parse(readFileSync("plugin/ghost.json", "utf8"));
    const params = manifest.tools.find((t: { name: string }) => t.name === "pstack_start").parameters;
    expect(params.properties.scope?.type).toBe("array");
    const h = fakeHost({
      node: (m: string) => {
        if (m === "git/state") return { ok: true, result: { root: "/repo", branch: "f", head: "abc" } };
        if (m === "worktree/create") return { ok: true, result: { path: "/repo/.worktrees/x" } };
        return { ok: false, message: m };
      },
    });
    const r: any = await runTool(makeContext(h, "c1", profile), "pstack_start", {
      task: "修复报错", repo_dir: "/repo", playbook: "bug-fix", scope: ["src/**"],
    });
    expect(r.ok).toBe(true);
    expect(r.result.next.kind).toBe("setup");
  });
});

describe("R33D-02 investigation workers reply with the report; the lead hands it in", () => {
  it("does not tell the worker to call keel_report", () => {
    const text = buildBrief(
      { id: "explore", role: "explorer", writes: false, inline_report: true },
      { run_id: "r1", goal: "g", taskType: "investigation" },
      { attempt: 1, dispatch_key: "r1:explore:1" },
    );
    expect(text).not.toMatch(/用 keel_report|keel_report\(/);
    expect(text).toContain("最后一条回复必须只包含一个");
    expect(text).toContain("r1:explore:1");
    expect(text).toContain("不要调用 keel_*");
  });
});

describe("R33D-03 read-only nodes must leave the worktree unchanged", () => {
  async function setup(files: string[]) {
    const h = fakeHost({
      node: (m: string) => (m === "git/changed-files" ? { ok: true, result: { files } } : { ok: false, message: m }),
    });
    await createRun(h, {
      run_id: "ro", spec_id: "bug-fix", profile_id: "sol", lead_harness: "codex", task_type: "bug-fix",
      entry: "explore", goal: "g", worktree: "/repo/.worktrees/x", now: h.now(), scopeAllow: ["src/**"],
    });
    await withRun(h, "ro", (raw) => {
      const s = raw as unknown as GraphRunState;
      s.cursor = "explore";
      s.team = { ready: true, team_id: "t", lead_session_id: "lead" };
      s.nodes.explore = {
        status: "active", attempts: 1, dispatch_key: "ro:explore:1", dispatch_state: "running",
        planned_params: {
          label: "keel-explore-1", role: "keel-explorer", agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy",
          initial_task: "x", writes: false, fallbacks: [], route_index: 0, start_sha: "abc",
        },
      };
    });
    return h;
  }
  const report = { status: "done", summary: "explored", files_changed: [], ran: [] };

  it("rejects an explorer that edited source, so its family cannot slip past the non-author check", async () => {
    const h = await setup(["src/duration.js", ".keel/explore-1.md"]);
    const r: any = await runTool(makeContext(h, "c1", profile, undefined, "lead"), "keel_report", {
      run_id: "ro", phase: "final", dispatch_key: "ro:explore:1", inline_report: report,
    });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("SCOPE_VIOLATION");
    expect(r.message).toContain("src/duration.js");
    expect(h.nodeCalls.find((c) => c.method === "git/changed-files")?.params).toMatchObject({ base: "abc" });
    const st = JSON.parse(h.files.get(graphStatePath("ro"))!) as GraphRunState;
    expect(st.nodes.explore.status).not.toBe("succeeded");
  });

  it("accepts a read-only node that only wrote its .keel report", async () => {
    const h = await setup([".keel/explore-1.md"]);
    const r: any = await runTool(makeContext(h, "c1", profile, undefined, "lead"), "keel_report", {
      run_id: "ro", phase: "final", dispatch_key: "ro:explore:1", inline_report: report,
    });
    expect(r.ok).toBe(true);
  });
});

describe("R33D-03 rereview: no unchecked read-only path", () => {
  it("does not dispatch a read-only node in a worktree when its start HEAD is unknown", async () => {
    const h = fakeHost({ node: (m: string) => ({ ok: false, message: m }) });
    await createRun(h, {
      run_id: "nohead", spec_id: "feature", profile_id: "sol", lead_harness: "codex", task_type: "feature",
      entry: "explore", goal: "g", worktree: "/repo/.worktrees/x", now: h.now(), scopeAllow: ["src/**"],
    });
    const r: any = await runTool(makeContext(h, "c1", profile, undefined, "lead"), "keel_report", {
      run_id: "nohead", phase: "setup", outcome: { worker_permission_mode: "bypassPermissions", team_id: "t" },
    });
    expect(r.ok).toBe(true);
    expect(r.result.next.kind).toBe("decide");
    expect(r.result.next.question).toContain("读不到 worktree HEAD");
  });

  it("ignores a repeated final for a finished read-only attempt instead of rewinding or skipping the check", async () => {
    const h = fakeHost({
      node: (m: string) => (m === "git/changed-files" ? { ok: true, result: { files: [] } } : { ok: false, message: m }),
    });
    await createRun(h, {
      run_id: "late", spec_id: "bug-fix", profile_id: "sol", lead_harness: "codex", task_type: "bug-fix",
      entry: "explore", goal: "g", worktree: "/repo/.worktrees/x", now: h.now(), scopeAllow: ["src/**"],
    });
    await withRun(h, "late", (raw) => {
      const s = raw as unknown as GraphRunState;
      s.cursor = "implement";
      s.team = { ready: true, team_id: "t", lead_session_id: "lead" };
      s.nodes.explore = {
        status: "succeeded", attempts: 1, dispatch_key: "late:explore:1", dispatch_state: "terminal",
        planned_params: {
          label: "keel-explore-1", role: "keel-explorer", agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy",
          initial_task: "x", writes: false, fallbacks: [], route_index: 0, start_sha: "abc",
        },
      };
    });
    const r: any = await runTool(makeContext(h, "c1", profile, undefined, "lead"), "keel_report", {
      run_id: "late", phase: "final", dispatch_key: "late:explore:1", inline_report: { status: "done", summary: "again", files_changed: [], ran: [] },
    });
    expect(r.ok).toBe(true);
    const st = JSON.parse(h.files.get(graphStatePath("late"))!) as GraphRunState;
    expect(st.cursor).toBe("implement");
    expect(st.nodes.explore.late_reports).toBe(1);
  });
});


describe("keel_run base_ref stacks a change on another PR branch", () => {
  it("creates the worktree from origin/<base_ref> and opens the PR against it", async () => {
    const h = fakeHost({
      node: (m: string) => {
        if (m === "git/state") return { ok: true, result: { root: "/repo", branch: "main", head: "abc" } };
        if (m === "worktree/create") return { ok: true, result: { path: "/repo/.worktrees/x" } };
        return { ok: false, message: m };
      },
    });
    const r: any = await runTool(makeContext(h, "c1", profile), "keel_run", {
      goal: "修登录报错", repo_dir: "/repo", lead: "codex", scope: ["src/**"], base_ref: "keel/pr7-tool-consolidation",
    });
    expect(r.ok).toBe(true);
    expect(h.nodeCalls.find((c) => c.method === "worktree/create")?.params).toMatchObject({ base_ref: "origin/keel/pr7-tool-consolidation" });
    const path = [...h.files.keys()].find((k) => k.endsWith("graph-state.json"))!;
    const st = JSON.parse(h.files.get(path)!) as GraphRunState;
    expect(st.base_ref).toBe("keel/pr7-tool-consolidation");
  });

  it("open-pr uses base_ref as the PR base when no PR is bound", async () => {
    const h = fakeHost();
    const spec = PSTACK_GRAPHS.pr;
    await createRun(h, {
      run_id: "run-base", spec_id: spec.id, profile_id: "sol", lead_harness: "codex", task_type: "pr",
      entry: "open-pr", goal: "g", worktree: "/repo/.worktrees/x", now: h.now(), base_ref: "keel/pr7-tool-consolidation",
    });
    const r = await advance(h, "run-base", { type: "tick" }, { spec });
    if (r.next.kind !== "wait") throw new Error("wait");
    expect(r.next.call.args).toMatchObject({ base: "keel/pr7-tool-consolidation" });
  });

  it("rejects a base_ref that is not a plain branch name", async () => {
    const h = fakeHost({ node: (m: string) => ({ ok: false, message: m }) });
    const r: any = await runTool(makeContext(h, "c1", profile), "keel_run", {
      goal: "修登录报错", repo_dir: "/repo", lead: "codex", scope: ["src/**"], base_ref: "main;rm -rf /",
    });
    expect(r.errorCode).toBe("INVALID_INPUT");
  });
});

describe("accepted receipt shapes (real run: receipt nested under outcome lost worker_session_id)", () => {
  async function run() {
    const h = fakeHost();
    await createRun(h, {
      run_id: "acc", spec_id: "bug-fix", profile_id: "sol", lead_harness: "codex", task_type: "bug-fix",
      entry: "explore", goal: "g", worktree: "/repo/.worktrees/x", now: h.now(), scopeAllow: ["src/**"],
    });
    await withRun(h, "acc", (raw) => {
      const s = raw as unknown as GraphRunState;
      s.cursor = "explore";
      s.team = { ready: true, team_id: "t", lead_session_id: "lead" };
      s.nodes.explore = {
        status: "active", attempts: 1, dispatch_key: "acc:explore:1", dispatch_state: "planned",
        planned_params: { label: "keel-explore-1", role: "keel-explorer", agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy", initial_task: "x", writes: false, fallbacks: [], route_index: 0 },
      };
    });
    return h;
  }

  it("records worker_session_id when the receipt is nested under outcome, so the worker is NOT_LEAD", async () => {
    const h = await run();
    const r: any = await runTool(makeContext(h, "c1", profile, undefined, "lead"), "keel_report", {
      run_id: "acc", phase: "accepted", dispatch_key: "acc:explore:1",
      outcome: { worker_id: "w1", worker_session_id: "ws-1", dispatch_outcome: { dispatched: true, wakeKind: "queued" }, queued_message_id: "q1" },
    });
    expect(r.ok).toBe(true);
    const st = JSON.parse(h.files.get(graphStatePath("acc"))!) as GraphRunState;
    expect(st.nodes.explore.worker_session_id).toBe("ws-1");
    const w: any = await runTool(makeContext(h, "c2", profile, undefined, "ws-1"), "keel_wait", { run_id: "acc", max_minutes: 1 });
    expect(w.errorCode).toBe("NOT_LEAD");
  });

  it("rejects an accepted report with no worker or task identity", async () => {
    const h = await run();
    const r: any = await runTool(makeContext(h, "c1", profile, undefined, "lead"), "keel_report", {
      run_id: "acc", phase: "accepted", dispatch_key: "acc:explore:1", outcome: { ok: true },
    });
    expect(r.errorCode).toBe("INVALID_INPUT");
  });
});
