import { afterEach, describe, expect, it } from "vitest";
import { graphStatePath } from "../../src/main/store/runs.ts";
import { makeWorld, makeE2eHost, startRun, leadLoop, cleanupRepos, SC } from "../e2e/helpers.ts";
import { usePluginResearch } from "./helpers.ts";

afterEach(cleanupRepos);

function researchKey(h: { files: Map<string, string> }, runId: string): string {
  const st = JSON.parse(h.files.get(graphStatePath(runId))!) as { nodes: Record<string, { dispatch_key?: string }> };
  return st.nodes.research?.dispatch_key ?? "";
}

describe("R29-R02 report identity", () => {
  usePluginResearch();
  it("A: trailing progress JSON after a failed final must not done", async () => {
    const world = makeWorld({ citation: "explorer-source:1" });
    const h = makeE2eHost(world);
    const start = await startRun(h, { goal: "调查登录原理", repo_dir: world.repoDir, lead: "codex", playbook: "investigation", sc: [...SC] });
    h.tasks!.readMessages = async () => {
      const key = researchKey(h, start.run_id);
      return {
        items: [
          { role: "assistant", text: JSON.stringify({ dispatch_key: key, status: "failed", summary: "actual final invalidates finding", citation: "research-source:1", sc_evidence: { "SC-1": false }, files_changed: [], ran: [] }) },
          { role: "assistant", text: JSON.stringify({ progress: 100, summary: "cleanup complete", citation: "cleanup-source:1" }) },
        ],
        nextCursor: null,
      };
    };
    const run = await leadLoop(h, start, world);
    expect(run.next.kind).not.toBe("done");
  });

  it("B: unparseable final after partial must not done", async () => {
    const world = makeWorld({ citation: "notes:1" });
    const h = makeE2eHost(world);
    const start = await startRun(h, { goal: "调查登录原理", repo_dir: world.repoDir, lead: "codex", playbook: "investigation", sc: [...SC] });
    h.tasks!.readMessages = async () => {
      const key = researchKey(h, start.run_id);
      return {
        items: [
          { role: "assistant", text: JSON.stringify({ dispatch_key: key, status: "partial", summary: "earlier provisional", citation: "notes:1", sc_evidence: { "SC-1": true }, files_changed: [], ran: [] }) },
          { role: "assistant", text: "```json\n{\"status\":\"failed\",\"summary\":\"final disproof\",}\n```" },
        ],
        nextCursor: null,
      };
    };
    const run = await leadLoop(h, start, world);
    expect(run.next.kind).not.toBe("done");
    expect(run.state.nodes.research?.last_report?.summary).not.toBe("earlier provisional");
  });

  it("single valid final can done", async () => {
    const world = makeWorld({ citation: "notes:1" });
    const h = makeE2eHost(world);
    const start = await startRun(h, { goal: "调查登录原理", repo_dir: world.repoDir, lead: "codex", playbook: "investigation", sc: [...SC] });
    const run = await leadLoop(h, start, world);
    expect(run.next.kind).toBe("done");
  });

  it("progress then a valid final can done", async () => {
    const world = makeWorld({ citation: "notes:1" });
    const h = makeE2eHost(world);
    const start = await startRun(h, { goal: "调查登录原理", repo_dir: world.repoDir, lead: "codex", playbook: "investigation", sc: [...SC] });
    h.tasks!.readMessages = async () => {
      const key = researchKey(h, start.run_id);
      return {
        items: [
          { role: "assistant", text: JSON.stringify({ progress: 50, summary: "working" }) },
          { role: "assistant", text: JSON.stringify({ dispatch_key: key, status: "done", summary: "research 完成", citation: "notes:1", sc_evidence: { "SC-1": true }, files_changed: [], ran: [] }) },
        ],
        nextCursor: null,
      };
    };
    const run = await leadLoop(h, start, world);
    expect(run.next.kind).toBe("done");
    expect(run.state.nodes.research?.last_report?.summary).toBe("research 完成");
  });
});
