import { describe, expect, it } from "vitest";
import { makeContext } from "../../src/main/context.ts";
import { runTool } from "../../src/main/dispatch.ts";
import { advance, createRun } from "../../src/main/graph/interpreter.ts";
import type { GraphRunState } from "../../src/main/graph/state.ts";
import { graphStatePath, withRun } from "../../src/main/store/runs.ts";
import { PSTACK_GRAPHS } from "../../src/shared/graph/pstack.ts";
import { LANE_PRESETS } from "../../src/shared/types.ts";
import { fakeHost } from "../helpers/fakeHost.ts";

const profile = { lanes: [], routingPath: null, boardRepos: [], plansDir: null };
const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BASE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function prSnap(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    result: {
      preset: "personal",
      rule: LANE_PRESETS.personal,
      pr: {
        repo: "o/r", number: 12, url: "https://github.com/o/r/pull/12", title: "t", state: "OPEN",
        isDraft: false, headSha: HEAD, headRef: "feat/x", baseRef: "main", mergeable: "MERGEABLE",
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

function bindNode(method: string) {
  if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "feat/x", head: HEAD } };
  if (method === "pr/resolve") return { ok: true, result: { repo: "o/r", number: 12 } };
  if (method === "pr/snapshot") return prSnap();
  if (method === "pr/threads") return { ok: true, result: { threads: [] } };
  if (method === "git/base-sha") return { ok: true, result: { base_ref: "main", base_sha: BASE, fetched: true } };
  if (method === "git/patch-id") return { ok: true, result: { ok: true, patch_id: "patch-xyz" } };
  if (method === "git/content-fingerprint") return { ok: true, result: { head: HEAD, status_digest: "d", content_hash: "h" } };
  if (method === "worktree/create") return { ok: true, result: { path: "/repo/.worktrees/x" } };
  return { ok: false, message: method };
}

describe("open-pr wait and PR binding", () => {
  it("open-pr next tells the lead to call pr_open then keel_wait", async () => {
    const h = fakeHost();
    const spec = PSTACK_GRAPHS.pr;
    await createRun(h, {
      run_id: "run-open",
      spec_id: spec.id,
      profile_id: "sol",
      lead_harness: "codex",
      task_type: "pr",
      entry: "open-pr",
      goal: "推进已有功能",
      worktree: "/repo/.worktrees/x",
      now: h.now(),
    });
    const r = await advance(h, "run-open", { type: "tick" }, { spec });
    expect(r.next.kind).toBe("wait");
    if (r.next.kind !== "wait") throw new Error("wait");
    expect(r.next.call.tool).toBe("pr_open");
    expect(r.next.call.args).toMatchObject({ repo_dir: "/repo/.worktrees/x" });
    expect(r.next.note).toMatch(/pr_open/);
    expect(r.next.after).toBe("keel_wait");
  });

  it("keel_wait binds the branch PR and writes base_sha", async () => {
    const h = fakeHost({ node: bindNode });
    const spec = PSTACK_GRAPHS.pr;
    await createRun(h, {
      run_id: "run-bind",
      spec_id: spec.id,
      profile_id: "sol",
      lead_harness: "codex",
      task_type: "pr",
      entry: "open-pr",
      goal: "开 PR",
      worktree: "/repo/.worktrees/x",
      now: h.now(),
    });
    await advance(h, "run-bind", { type: "tick" }, { spec });
    const r: any = await runTool(makeContext(h, "c1", profile), "keel_wait", { run_id: "run-bind" });
    expect(r.ok).toBe(true);
    const st = JSON.parse(h.files.get(graphStatePath("run-bind"))!) as GraphRunState;
    expect(st.pr).toBe(12);
    expect(st.pr_binding).toMatchObject({ repo: "o/r", number: 12, base_ref: "main", base_sha: BASE, head_sha: HEAD });
  });
});

describe("tool nodes that are not CI", () => {
  it("investigation report goes through keel_wait into the done check", async () => {
    const h = fakeHost({ node: bindNode });
    const spec = PSTACK_GRAPHS.investigation;
    await createRun(h, {
      run_id: "run-inv",
      spec_id: spec.id,
      profile_id: "sol",
      lead_harness: "codex",
      task_type: "investigation",
      entry: "report",
      goal: "调查超时原理",
      worktree: "/repo",
      repo: "/repo",
      now: h.now(),
    });
    await withRun(h, "run-inv", (raw) => {
      const s = raw as unknown as GraphRunState;
      s.start_state = { head: HEAD, status_digest: "d", content_hash: "h" };
      s.sc = [{ id: "SC-1", text: "查明原因" }];
    });
    await advance(h, "run-inv", { type: "tick" }, { spec });
    await withRun(h, "run-inv", (raw) => {
      const s = raw as unknown as GraphRunState;
      s.nodes.report = {
        ...(s.nodes.report ?? { status: "active", attempts: 1 }),
        last_report: { status: "done", summary: "ok", citation: "notes.md:1", sc_evidence: { "SC-1": true }, fresh: true },
      };
    });
    const r: any = await runTool(makeContext(h, "c2", profile), "keel_wait", { run_id: "run-inv" });
    expect(r.ok).toBe(true);
    expect(["done", "decide"]).toContain(r.result.next.kind);
    const st = JSON.parse(h.files.get(graphStatePath("run-inv"))!) as GraphRunState;
    if (r.result.next.kind === "decide") expect(r.result.next.gate_id).toBe("done");
    else expect(st.status).toBe("done");
  });
});

describe("verifier verdict uses pr_binding.base_sha", () => {
  it("builds a verdict with base_sha from the bound PR", async () => {
    const h = fakeHost({ node: bindNode });
    const started: any = await runTool(makeContext(h, "c1", profile), "keel_run", {
      goal: "修登录报错", repo_dir: "/repo", lead: "codex", scope: ["src/**"],
    });
    const runId = started.result.run_id as string;
    const key = `${runId}:verify-same-surface:1`;
    await withRun(h, runId, (raw) => {
      const s = raw as unknown as GraphRunState;
      s.pr = 12;
      s.repo = "o/r";
      s.worktree = "/repo/.worktrees/x";
      s.pr_binding = { repo: "o/r", number: 12, base_ref: "main", base_sha: BASE, head_sha: HEAD };
      s.nodes["verify-same-surface"] = {
        status: "active",
        attempts: 1,
        dispatch_key: key,
        dispatch_state: "running",
        planned_params: {
          label: "keel-ver-1",
          role: "keel-verifier",
          agent: "pi",
          model: "gpt-6-astra",
          provider_id: "art-cindy",
          initial_task: "v",
          writes: false,
          fallbacks: [],
          route_index: 0,
        },
        actual_route: { agent: "pi", model: "gpt-6-astra", provider_id: "art-cindy" },
      };
    });
    const r: any = await runTool(makeContext(h, "c2", profile), "keel_report", {
      run_id: runId,
      phase: "final",
      dispatch_key: key,
      inline_report: {
        status: "done",
        summary: "ok",
        ran: [{ cmd: "npm test", exit_code: 0 }],
        files_changed: [],
        verdict: "PASS",
      },
    });
    expect(r.ok).toBe(true);
    const st = JSON.parse(h.files.get(graphStatePath(runId))!) as GraphRunState;
    expect(st.verdict?.base_sha).toBe(BASE);
    expect(st.verdict?.head).toBe(HEAD);
    expect(st.verdict?.patch_id).toBe("patch-xyz");
  });
});
