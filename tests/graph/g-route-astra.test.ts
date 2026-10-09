import { describe, expect, it } from "vitest";
import { makeContext } from "../../src/main/context.ts";
import { runTool } from "../../src/main/dispatch.ts";
import { graphStatePath } from "../../src/main/store/runs.ts";
import { fakeHost, typesafeAnswering } from "../helpers/fakeHost.ts";

const profile = { lanes: [], routingPath: null, boardRepos: [], plansDir: null };

function nodeOk(method: string) {
  if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "main", head: "a".repeat(40), gh_repo: "acme/app" } };
  if (method === "git/content-fingerprint") return { ok: true, result: { head: "a".repeat(40), status_digest: "d", content_hash: "h" } };
  if (method === "worktree/create") return { ok: true, result: { path: "/repo/.worktrees/keel-x" } };
  return { ok: false, message: method };
}

describe("G-route entry with direction_gate=astra", () => {
  it("consults Architect and consumes astra budget instead of folding to await_sol", async () => {
    const h = fakeHost({ fetch: typesafeAnswering(0.2), node: nodeOk });
    const started = await runTool(makeContext(h, "c1", profile), "keel_run", {
      goal: "重构登录功能",
      repo_dir: "/repo",
      lead: "claude-code",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const result = started.result as { run_id: string; next: { kind: string } };
    expect(result.next.kind).not.toBe("decide");
    const afterSetup = result.next.kind === "setup"
      ? await runTool(makeContext(h, "c2", profile), "keel_report", {
          run_id: result.run_id,
          phase: "setup",
          outcome: { worker_permission_mode: "bypassPermissions", team_id: "t1" },
        })
      : started;
    expect(afterSetup.ok).toBe(true);
    if (!afterSetup.ok) return;
    const next = (afterSetup.result as { next: { kind: string } }).next;
    const st = JSON.parse(h.files.get(graphStatePath(result.run_id))!);
    expect(st.astra_calls ?? 0).toBeGreaterThan(0);
    expect(next.kind).toBe("dispatch");
  });
});
