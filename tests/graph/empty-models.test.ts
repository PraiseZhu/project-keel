import { describe, expect, it } from "vitest";
import { advance } from "../../src/main/graph/interpreter.ts";
import { fakeHost } from "../helpers/fakeHost.ts";
import { boot, setupOk } from "./helpers.ts";

describe("SC-16 empty live model list", () => {
  it("stops instead of treating an empty /agent-models list as all routes available", async () => {
    const { h, spec } = await boot({}, undefined);
    h.agentModelList = [];
    const ready = await setupOk(h, spec);
    expect(ready.next.kind).toBe("stop");
    if (ready.next.kind === "stop") {
      expect(ready.next.reason).toMatch(/清单为空|模型清单/);
    }
  });

  it("stops when /agent-models ok=false even if leftover models are present", async () => {
    const leftover = [{ id: "gpt-6-luna", agent: "codex", providerId: "art-cindy", efforts: ["high"], visible: true }];
    const host = fakeHost({
      agentModelsResponse: { ok: false, status: 500, models: leftover },
      node: (method: string) => {
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "feat/x", head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } };
        return { ok: false, message: method };
      },
    });
    const { spec } = await boot({}, host);
    const first = await advance(host, "run1", { type: "tick" }, { spec });
    expect(first.next.kind).toBe("setup");
    const ready = await advance(host, "run1", {
      type: "report", phase: "setup", outcome: { worker_permission_mode: "bypassPermissions", team_id: "team-1" }, session_id: "sol-1",
    }, { spec });
    expect(ready.next.kind).toBe("stop");
    if (ready.next.kind === "stop") expect(ready.next.reason).toMatch(/清单为空|模型清单/);
  });
});
