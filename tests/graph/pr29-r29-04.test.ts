import { afterEach, describe, expect, it } from "vitest";
import { collectTaskMessages, type CindyTasksApi } from "../../src/main/host/tasks.ts";
import { makeWorld, makeE2eHost, startRun, leadLoop, cleanupRepos, SC } from "../e2e/helpers.ts";

afterEach(cleanupRepos);

describe("R29-04 paged messages", () => {
  it("reads every page and uses the last report, not an earlier partial", async () => {
    const calls: Record<string, unknown>[] = [];
    const api: CindyTasksApi = {
      async create() { return {}; },
      async send() { return {}; },
      async getRun() { return { status: "completed" }; },
      async readMessages(args) {
        calls.push(args);
        if (!args.after) {
          return { items: [{ role: "assistant", text: JSON.stringify({ status: "partial", summary: "provisional finding" }) }], nextCursor: "final-page" };
        }
        return { items: [{ role: "assistant", text: JSON.stringify({ status: "failed", summary: "final conclusion disproved" }) }], nextCursor: null };
      },
    };
    const out = await collectTaskMessages(api, "t1");
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(out)).toContain("final conclusion disproved");
  });

  it("PAGED_FALSE_DONE: earlier partial must not make investigation done", async () => {
    const world = makeWorld({ citation: "notes:1" });
    const h = makeE2eHost(world);
    let pages = 0;
    h.tasks!.readMessages = async (args: Record<string, unknown>) => {
      pages++;
      if (!args.after) {
        return { items: [{ role: "assistant", text: JSON.stringify({ status: "partial", summary: "provisional finding", citation: "notes:1", sc_evidence: { "SC-1": true } }) }], nextCursor: "final-page" };
      }
      return { items: [{ role: "assistant", text: JSON.stringify({ status: "failed", summary: "final conclusion disproved", citation: "notes:1", sc_evidence: { "SC-1": false } }) }], nextCursor: null };
    };
    const start = await startRun(h, { goal: "调查登录原理", repo_dir: world.repoDir, lead: "codex", playbook: "investigation", sc: [...SC] });
    const run = await leadLoop(h, start, world);
    expect(pages).toBeGreaterThanOrEqual(2);
    expect(run.next.kind).not.toBe("done");
    expect(run.state.nodes.research?.last_report?.status).toBe("failed");
    expect(run.state.nodes.research?.last_report?.summary).toBe("final conclusion disproved");
  });
});
