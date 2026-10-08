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

describe("G-route at keel_run", () => {
  it("does not create a run when keywords hit more than one graph and Jev is low; keel_gate then starts it", async () => {
    const h = fakeHost({ fetch: typesafeAnswering(0.2), node: nodeOk });
    const started: any = await runTool(makeContext(h, "c1", profile), "keel_run", {
      goal: "重构登录功能",
      repo_dir: "/repo", scope: ["src/**", "tests/**"],
      lead: "codex",
    });
    expect(started.ok).toBe(true);
    expect(started.result.next.kind).toBe("decide");
    expect(started.result.next.gate_id).toBe("G-route");
    expect(started.result.next.options).toEqual(expect.arrayContaining(["refactoring", "feature"]));
    const runId = started.result.run_id as string;
    expect(h.nodeCalls.some((c) => c.method === "worktree/create")).toBe(false);
    const gated: any = await runTool(makeContext(h, "c2", profile), "keel_gate", {
      run_id: runId,
      gate_id: "G-route",
      answer: "refactoring",
    });
    expect(gated.ok).toBe(true);
    expect(gated.result.next.kind).not.toBe("decide");
    const st = JSON.parse(h.files.get(graphStatePath(runId))!);
    expect(st.task_type).toBe("refactoring");
    expect(st.spec_id).toBe("refactoring");
  });

  it("still starts immediately when keywords hit exactly one graph", async () => {
    const h = fakeHost({ fetch: typesafeAnswering(0.2), node: nodeOk });
    const r: any = await runTool(makeContext(h, "c1", profile), "keel_run", {
      goal: "修登录报错",
      repo_dir: "/repo", scope: ["src/**", "tests/**"],
      lead: "codex",
    });
    expect(r.ok).toBe(true);
    expect(r.result.next.kind).toBe("setup");
    expect(JSON.parse(h.files.get(graphStatePath(r.result.run_id))!).task_type).toBe("bug-fix");
  });

  it("honours an explicit playbook without asking G-route", async () => {
    const h = fakeHost({ fetch: typesafeAnswering(0.99, () => "bug-fix"), node: nodeOk });
    const r: any = await runTool(makeContext(h, "c1", profile), "keel_run", {
      goal: "重构登录功能",
      repo_dir: "/repo", scope: ["src/**", "tests/**"],
      lead: "codex",
      playbook: "investigation",
    });
    expect(r.ok).toBe(true);
    expect(JSON.parse(h.files.get(graphStatePath(r.result.run_id))!).task_type).toBe("investigation");
  });
});
