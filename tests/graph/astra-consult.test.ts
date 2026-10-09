import { describe, expect, it } from "vitest";
import { makeContext } from "../../src/main/context.ts";
import { runTool } from "../../src/main/dispatch.ts";
import { advance, createRun } from "../../src/main/graph/interpreter.ts";
import { graphStatePath, withRun } from "../../src/main/store/runs.ts";
import type { GraphRunState } from "../../src/main/graph/state.ts";
import { PSTACK_GRAPHS } from "../../src/shared/graph/pstack.ts";
import { fakeHost, typesafeAnswering } from "../helpers/fakeHost.ts";

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
    if (first.next?.kind === "dispatch") expect(first.next.create_worker?.role).toBe("keel-architect");

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
    expect(r.result.next.kind).not.toBe("dispatch");
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
