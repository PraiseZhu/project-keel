import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { makeWorld, makeE2eHost, startRun, leadLoop, cleanupRepos, SC } from "../e2e/helpers.ts";
import { LANE_PRESETS } from "../../src/shared/types.ts";
import { mapChangeDoneFailure } from "../../src/main/tools/keel.ts";
import type { GraphRunState } from "../../src/main/graph/state.ts";

afterEach(cleanupRepos);

describe("gated-handoff done gate", () => {
  it("emits pr_ready with auth/review placeholders and completes after success", async () => {
    const world = makeWorld();
    const host = makeE2eHost(world);
    const original = host.node.bind(host);
    host.node = async (method, params, opts) => {
      const response = await original(method, params, opts);
      if (method === "pr/snapshot" && response.ok) {
        return {
          ok: true as const,
          result: {
            ...(response.result as object),
            preset: "gated-handoff",
            rule: LANE_PRESETS["gated-handoff"],
            gate: { applies: true, required: ["verify"], passed: ["verify"], failing: [], pending: [], missing: [], ok: true, sources: ["test"] },
          },
        };
      }
      return response;
    };
    const started = await startRun(host, { goal: "修登录报错", repo_dir: world.repoDir, lead: "codex", playbook: "bug-fix", scope: ["src/**"], sc: [...SC] });
    const stalled = await leadLoop(host, started, world, {
      stopWhen: (next) =>
        (next.kind === "wait" && next.call.tool === "pr_ready") ||
        (next.kind === "decide" && next.gate_id === "done") ||
        next.kind === "done",
    });
    expect(stalled.next.kind).toBe("wait");
    if (stalled.next.kind !== "wait") return;
    expect(stalled.next.call.tool).toBe("pr_ready");
    expect(stalled.next.call.args).toEqual(expect.objectContaining({
      run_id: started.run_id,
      authorization_source: expect.any(String),
      review_entry: expect.objectContaining({ result: "", checked_at: "", source: "" }),
    }));
    const finished = await leadLoop(host, { run_id: started.run_id, next: stalled.next, worktree: stalled.worktree }, world);
    expect(finished.next.kind).toBe("done");
    expect(finished.state.status).toBe("done");
    expect(host.nodeCalls.some((x) => x.method === "pr/ready")).toBe(true);
  });

  it("handoff next.review_entry.result is empty, not pass", () => {
    const next = mapChangeDoneFailure(
      { run_id: "r1", verdict: { head: "a".repeat(40) } } as GraphRunState,
      { done: false, missing: ["pr_status 是 handoff，不是可合并/已交接/已关闭"], next: "wait" },
    );
    expect(next.kind).toBe("wait");
    if (next.kind !== "wait" || next.call.tool !== "pr_ready") return;
    const entry = next.call.args.review_entry as { result: string; head_sha: string; checked_at: string; source: string };
    expect(entry.result).toBe("");
    expect(entry.result).not.toBe("pass");
    expect(entry.checked_at).toBe("");
    expect(entry.source).toBe("");
    expect(entry.head_sha).toBe("a".repeat(40));
    expect(next.note).toMatch(/authorization_source/);
    expect(next.note).toMatch(/requireReviewEntry: true/);
    expect(next.note).toMatch(/缺省或 false 时可省略/);
    expect(next.note).toMatch(/不得编造/);
  });

  it("pr_ready contract documents optional review_entry gated by requireReviewEntry", () => {
    const ghost = JSON.parse(readFileSync(new URL("../../plugin/ghost.json", import.meta.url), "utf8")) as {
      tools: Array<{ name: string; description: string; parameters: { required?: string[]; properties: Record<string, { description?: string }> } }>;
    };
    const tool = ghost.tools.find((t) => t.name === "pr_ready");
    expect(tool).toBeTruthy();
    expect(tool!.description).toMatch(/requireReviewEntry: true/);
    expect(tool!.description).toMatch(/缺省 false/);
    expect(tool!.parameters.properties.review_entry?.description).toMatch(/requireReviewEntry: true/);
    expect(tool!.parameters.properties.review_entry?.description).toMatch(/缺省 false/);
    expect(tool!.parameters.required ?? []).not.toContain("review_entry");
  });
});
