import { describe, expect, it } from "vitest";
import { advance } from "../../src/main/graph/interpreter.ts";
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
});
