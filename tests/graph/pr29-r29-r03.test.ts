import { afterEach, describe, expect, it } from "vitest";
import { graphStatePath } from "../../src/main/store/runs.ts";
import { makeWorld, makeE2eHost, startRun, leadLoop, cleanupRepos, SC } from "../e2e/helpers.ts";

afterEach(cleanupRepos);

function researchKey(h: { files: Map<string, string> }, runId: string): string {
  const st = JSON.parse(h.files.get(graphStatePath(runId))!) as { nodes: Record<string, { dispatch_key?: string }> };
  return st.nodes.research?.dispatch_key ?? "";
}

const body = (key: string, status: string, evidence = true) => ({
  dispatch_key: key,
  status,
  summary: `${status} report`,
  citation: "source:1",
  sc_evidence: { "SC-1": evidence },
  files_changed: [] as string[],
  ran: [] as unknown[],
});

async function investigation(messages: (key: string) => unknown[]) {
  const world = makeWorld({ citation: "explorer:1" });
  const h = makeE2eHost(world);
  const start = await startRun(h, { goal: "调查登录原理", repo_dir: world.repoDir, lead: "codex", playbook: "investigation", sc: [...SC] });
  h.tasks!.readMessages = async () => ({ items: messages(researchKey(h, start.run_id)), nextCursor: null });
  const run = await leadLoop(h, start, world);
  return run;
}

describe("R29-R03 last assistant message only", () => {
  it("UNCLOSED_FENCE_FALSE_DONE cannot be done", async () => {
    const run = await investigation((key) => [
      { role: "assistant", text: JSON.stringify(body(key, "partial")) },
      { role: "assistant", text: "```json\n" + JSON.stringify(body(key, "failed", false)).slice(0, -1) },
    ]);
    expect(run.next.kind).not.toBe("done");
    expect(run.state.nodes.research?.last_report).toBeUndefined();
  });

  it("last progress JSON is unconfirmed, not done", async () => {
    const run = await investigation((key) => [
      { role: "assistant", text: JSON.stringify(body(key, "failed", false)) },
      { role: "assistant", text: JSON.stringify({ progress: 100, summary: "cleanup complete" }) },
    ]);
    expect(run.next.kind).not.toBe("done");
  });

  it("last valid final can done", async () => {
    const run = await investigation((key) => [
      { role: "assistant", text: JSON.stringify({ progress: 50 }) },
      { role: "assistant", text: JSON.stringify(body(key, "done")) },
    ]);
    expect(run.next.kind).toBe("done");
    expect(run.state.nodes.research?.last_report?.status).toBe("done");
  });

  it("last user message is not adopted", async () => {
    const run = await investigation((key) => [
      { role: "assistant", text: JSON.stringify(body(key, "failed", false)) },
      { role: "user", text: JSON.stringify(body(key, "done")) },
    ]);
    expect(run.next.kind).not.toBe("done");
    expect(run.state.nodes.research?.last_report).toBeUndefined();
  });
});
