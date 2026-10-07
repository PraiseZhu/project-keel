import { describe, expect, it } from "vitest";
import { invokeCindyTasks, toCindyTasksCall, type CindyTasksApi } from "../../src/main/host/tasks.ts";

describe("plugin_task → cindy.tasks", () => {
  it("maps create/send/getRun/readMessages onto §4.11.3 fields", () => {
    expect(
      toCindyTasksCall({
        phase: "create",
        request_key: "rk-create",
        body: { agentKind: "research", providerId: "prov", model: "m1", effort: "high", isolatedWorkspace: true },
      }),
    ).toEqual({
      method: "create",
      args: {
        requestKey: "rk-create",
        title: "KEEL node",
        isolatedWorkspace: true,
        route: { agentKind: "research", providerId: "prov", model: "m1", effort: "high", fastMode: false },
      },
    });
    expect(
      toCindyTasksCall({
        phase: "send",
        request_key: "rk-send",
        task_id: "t1",
        expected_revision: 3,
        text: "hello",
      }),
    ).toEqual({
      method: "send",
      args: { taskId: "t1", expectedRevision: 3, requestKey: "rk-send", text: "hello" },
    });
    expect(toCindyTasksCall({ phase: "getRun", task_run_id: "run-abc" })).toEqual({
      method: "getRun",
      args: { runId: "run-abc" },
    });
    expect(toCindyTasksCall({ phase: "getRun", request_key: "create:k" })).toEqual({
      method: "getRun",
      args: { requestKey: "create:k" },
    });
    expect(toCindyTasksCall({ phase: "readMessages", task_id: "t1" })).toEqual({
      method: "readMessages",
      args: { taskId: "t1", limit: 50 },
    });
  });

  it("invokes cindy.tasks internally and surfaces SDK errors", async () => {
    const calls: { method: string; args: unknown }[] = [];
    const api: CindyTasksApi = {
      async create(args) {
        calls.push({ method: "create", args });
        return { taskId: "t1", revision: 1 };
      },
      async send(args) {
        calls.push({ method: "send", args });
        return { revision: 2 };
      },
      async getRun(args) {
        calls.push({ method: "getRun", args });
        return { status: "running" };
      },
      async readMessages(args) {
        calls.push({ method: "readMessages", args });
        return { messages: [] };
      },
    };
    const created = await invokeCindyTasks(api, {
      phase: "create",
      request_key: "rk",
      body: { agentKind: "research", providerId: "p", model: "m" },
    });
    expect(created).toEqual({ ok: true, data: { taskId: "t1", revision: 1 } });
    expect(calls[0]?.method).toBe("create");
    const boom = Object.assign(new Error("busy"), { code: "TASKS_BUSY" });
    const failing: CindyTasksApi = {
      ...api,
      async send() {
        throw boom;
      },
    };
    const failed = await invokeCindyTasks(failing, { phase: "send", task_id: "t1", request_key: "rk", text: "x" });
    expect(failed).toEqual({ ok: false, errorCode: "TASKS_BUSY", message: "busy" });
  });
});
