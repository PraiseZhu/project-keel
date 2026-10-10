import { describe, expect, it } from "vitest";
import { makeContext } from "../../src/main/context.ts";
import { runTool } from "../../src/main/dispatch.ts";
import { createRun } from "../../src/main/graph/interpreter.ts";
import type { GraphRunState } from "../../src/main/graph/state.ts";
import type { CindyTasksApi } from "../../src/main/host/tasks.ts";
import { graphStatePath, withRun } from "../../src/main/store/runs.ts";
import { PSTACK_GRAPHS } from "../../src/shared/graph/pstack.ts";
import { usePluginResearch } from "./helpers.ts";
import { fakeHost } from "../helpers/fakeHost.ts";

const profile = { lanes: [], routingPath: null, boardRepos: [], plansDir: null };

function recordingTasks(over: Partial<CindyTasksApi> = {}): { api: CindyTasksApi; calls: { method: string; args: unknown }[] } {
  const calls: { method: string; args: unknown }[] = [];
  const impl: CindyTasksApi = {
    async create() { return { taskId: "task-1", revision: 1 }; },
    async send() { return { runId: "trun-1", revision: 2 }; },
    async getRun() { return { ok: true, taskId: "task-1", revision: 1, status: "idle" }; },
    async readMessages() { return { messages: [] }; },
    async list() { return { items: [] }; },
    ...over,
  };
  const api: CindyTasksApi = {
    async create(args) { calls.push({ method: "create", args }); return impl.create(args); },
    async send(args) { calls.push({ method: "send", args }); return impl.send(args); },
    async getRun(args) { calls.push({ method: "getRun", args }); return impl.getRun(args); },
    async readMessages(args) { calls.push({ method: "readMessages", args }); return impl.readMessages(args); },
    async list(args) { calls.push({ method: "list", args }); return (impl.list ?? (async () => ({ items: [] })))(args); },
  };
  return { api, calls };
}

async function plantResearch(h: ReturnType<typeof fakeHost>) {
  const spec = PSTACK_GRAPHS.investigation;
  await createRun(h, {
    run_id: "run-pt",
    spec_id: spec.id,
    profile_id: "sol",
    lead_harness: "codex",
    task_type: "investigation",
    entry: "research",
    goal: "调查超时原理",
    invocation_dir: "/repo",
    now: h.now(),
  });
  await withRun(h, "run-pt", (raw) => {
    const s = raw as unknown as GraphRunState;
    s.team = { ready: true, team_id: "t1" };
  });
}

describe("plugin_task executes inside KEEL", () => {
  usePluginResearch();
  it("research goes create → send internally, then final reports", async () => {
    const { api, calls } = recordingTasks();
    const h = fakeHost({
      tasks: api,
      node: (method: string) => {
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "main", head: "a".repeat(40) } };
        if (method === "git/content-fingerprint") return { ok: true, result: { head: "a".repeat(40), status_digest: "d", content_hash: "h" } };
        return { ok: false, message: method };
      },
    });
    await plantResearch(h);
    const tick: any = await runTool(makeContext(h, "c1", profile), "keel_gate", {
      run_id: "run-pt", gate_id: "unused", answer: "x",
    });
    expect(tick.ok).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(["create", "send"]);
    expect(tick.result.next.kind).not.toBe("dispatch");
    const st = JSON.parse(h.files.get(graphStatePath("run-pt"))!) as GraphRunState;
    expect(st.nodes.research?.task).toMatchObject({ task_id: "task-1", run_id: "trun-1", phase: "send" });
    expect(st.nodes.research?.dispatch_state).toBe("running");
    const key = st.nodes.research!.dispatch_key!;
    const fin: any = await runTool(makeContext(h, "c2", profile), "keel_report", {
      run_id: "run-pt",
      phase: "final",
      dispatch_key: key,
      inline_report: { status: "done", summary: "ok", citation: "notes.md:1", sc_evidence: { "SC-1": true } },
    });
    expect(fin.ok).toBe(true);
    expect(JSON.parse(h.files.get(graphStatePath("run-pt"))!).nodes.research.status).toBe("succeeded");
  });

  it("lost create receipt reconcilies via list requestKey and does not replay create", async () => {
    let creates = 0;
    const { api, calls } = recordingTasks({
      async create() {
        creates += 1;
        return {};
      },
      async list() {
        return { items: [{ taskId: "task-recovered", revision: 1, requestKey: "create:run-pt:research:1" }] };
      },
    });
    const h = fakeHost({
      tasks: api,
      node: (method: string) => {
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "main", head: "a".repeat(40) } };
        if (method === "git/content-fingerprint") return { ok: true, result: { head: "a".repeat(40), status_digest: "d", content_hash: "h" } };
        return { ok: false, message: method };
      },
    });
    await plantResearch(h);
    const tick: any = await runTool(makeContext(h, "c1", profile), "keel_gate", {
      run_id: "run-pt", gate_id: "unused", answer: "x",
    });
    expect(tick.ok).toBe(true);
    expect(creates).toBe(1);
    expect(calls.map((c) => c.method)).toEqual(["create", "list", "send"]);
    expect(calls.find((c) => c.method === "getRun")).toBeUndefined();
    const st = JSON.parse(h.files.get(graphStatePath("run-pt"))!) as GraphRunState;
    expect(st.nodes.research?.task?.task_id).toBe("task-recovered");
    expect(st.nodes.research?.task?.revision).toBe(1);
    expect(st.nodes.research?.task?.run_id).toBe("trun-1");
  });

  it("polls getRun by runId until completed then finals from readMessages", async () => {
    let polls = 0;
    let h: ReturnType<typeof fakeHost>;
    const { api, calls } = recordingTasks({
      async getRun(args) {
        expect(args).toEqual({ runId: "trun-1" });
        polls += 1;
        return { status: polls === 1 ? "running" : "completed", runId: "trun-1" };
      },
      async readMessages() {
        const st = JSON.parse(h.files.get(graphStatePath("run-pt"))!) as GraphRunState;
        const key = st.nodes.research?.dispatch_key ?? "";
        return { messages: [{ role: "assistant", text: JSON.stringify({ dispatch_key: key, status: "done", summary: "ok", citation: "notes.md:1", sc_evidence: { "SC-1": true } }) }] };
      },
    });
    h = fakeHost({
      tasks: api,
      node: (method: string) => {
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "main", head: "a".repeat(40) } };
        if (method === "git/content-fingerprint") return { ok: true, result: { head: "a".repeat(40), status_digest: "d", content_hash: "h" } };
        return { ok: false, message: method };
      },
    });
    await plantResearch(h);
    await withRun(h, "run-pt", (raw) => {
      (raw as unknown as GraphRunState).sc = [{ id: "SC-1", text: "根因" }];
      (raw as unknown as GraphRunState).start_state = { head: "a".repeat(40), status_digest: "d", content_hash: "h" };
    });
    const started: any = await runTool(makeContext(h, "c1", profile), "keel_gate", {
      run_id: "run-pt", gate_id: "unused", answer: "x",
    });
    expect(started.ok).toBe(true);
    const waited: any = await runTool(makeContext(h, "c2", profile), "keel_wait", { run_id: "run-pt" });
    expect(waited.ok).toBe(true);
    expect(calls.filter((c) => c.method === "getRun").every((c) => Object.keys(c.args as object).join() === "runId")).toBe(true);
    const st = JSON.parse(h.files.get(graphStatePath("run-pt"))!) as GraphRunState;
    expect(st.nodes.research?.last_report?.citation).toBe("notes.md:1");
    expect(typeof st.nodes.research?.task?.revision).toBe("number");
  });
});
