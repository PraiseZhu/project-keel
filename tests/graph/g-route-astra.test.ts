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
    const started: { ok: boolean; result?: { run_id: string; next: { kind: string } } } = await runTool(makeContext(h, "c1", profile), "keel_run", {
      goal: "重构登录功能",
      repo_dir: "/repo",
      lead: "claude-code",
    });
    expect(started.ok).toBe(true);
    const st = JSON.parse(h.files.get(graphStatePath(started.result!.run_id))!);
    expect(st.astra_calls ?? 0).toBeGreaterThan(0);
    expect(started.result!.next.kind).not.toBe("decide");
  });
});
