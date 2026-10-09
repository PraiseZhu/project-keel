import { describe, expect, it } from "vitest";
import { makeContext } from "../../src/main/context.ts";
import { runTool } from "../../src/main/dispatch.ts";
import { graphStatePath, withRun } from "../../src/main/store/runs.ts";
import type { GraphRunState } from "../../src/main/graph/state.ts";
import { fakeHost } from "../helpers/fakeHost.ts";

const profile = { lanes: [], routingPath: null, boardRepos: [], plansDir: null };
const HEAD = "a".repeat(40);

describe("SCOPE_VIOLATION walks the fail edge", () => {
  it("marks the writing node failed and moves onto g-retry", async () => {
    const h = fakeHost({
      node: (method: string) => {
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "f", head: HEAD, gh_repo: "o/r" } };
        if (method === "worktree/create") return { ok: true, result: { path: "/repo/.worktrees/x" } };
        if (method === "git/changed-files") return { ok: true, result: { files: ["outside.txt"] } };
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
      s.cursor = "implement";
      s.team = { ready: true, team_id: "t1" };
      s.nodes.implement = {
        status: "active",
        attempts: 1,
        dispatch_key: key,
        dispatch_state: "running",
        planned_params: {
          label: "keel-impl", role: "keel-worker", agent: "pi", model: "grok-4.6", provider_id: "art-cindy",
          initial_task: "x", writes: true, fallbacks: [], route_index: 0, scopeAllow: ["src/**"], start_sha: HEAD,
        },
      };
    });
    const r: any = await runTool(makeContext(h, "c2", profile), "keel_report", {
      run_id: runId,
      phase: "final",
      dispatch_key: key,
      inline_report: { status: "done", summary: "leaked", files_changed: ["outside.txt"], ran: [] },
    });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("SCOPE_VIOLATION");
    const st = JSON.parse(h.files.get(graphStatePath(runId))!) as GraphRunState;
    const impl = st.nodes.implement;
    const left = st.cursor === "g-retry-implement" || (st.cursor?.startsWith("g-retry") ?? false);
    const retried = (impl?.attempts ?? 0) > 1 || impl?.status === "failed";
    expect(left || retried, `cursor=${st.cursor} implement=${JSON.stringify(impl?.status)} attempts=${impl?.attempts}`).toBe(true);
    expect(impl?.dispatch_key === key && impl?.dispatch_state === "running").toBe(false);
  });
});
