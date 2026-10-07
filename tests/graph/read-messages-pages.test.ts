import { describe, expect, it } from "vitest";
import { collectTaskMessages, type CindyTasksApi } from "../../src/main/host/tasks.ts";

describe("readMessages pagination", () => {
  it("follows items/nextCursor/after until a final JSON report or the page cap", async () => {
    const calls: Record<string, unknown>[] = [];
    const api: CindyTasksApi = {
      async create() { return {}; },
      async send() { return {}; },
      async getRun() { return {}; },
      async readMessages(args) {
        calls.push(args);
        if (!args.after) {
          return { items: [{ role: "assistant", text: "still working" }], nextCursor: "p2" };
        }
        if (args.after === "p2") {
          return {
            items: [{ role: "assistant", text: "```json\n{\"status\":\"done\",\"summary\":\"from page 2\"}\n```" }],
            nextCursor: "p3",
          };
        }
        return { items: [{ role: "assistant", text: "should not read" }], nextCursor: null };
      },
    };
    const out = await collectTaskMessages(api, "task-1");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(calls).toEqual([
      { taskId: "task-1", limit: 50 },
      { taskId: "task-1", limit: 50, after: "p2" },
    ]);
    expect(JSON.stringify(out.data)).toContain("from page 2");
  });
});
