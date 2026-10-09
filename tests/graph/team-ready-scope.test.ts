import { describe, expect, it } from "vitest";
import { advance } from "../../src/main/graph/interpreter.ts";
import { withRun } from "../../src/main/store/runs.ts";
import type { GraphRunState } from "../../src/main/graph/state.ts";
import { boot, setupOk } from "./helpers.ts";

describe("SC-18 team_ready scope", () => {
  it("re-setups when the current lead session is not the stored one", async () => {
    const { h, spec } = await boot();
    const ready = await setupOk(h, spec);
    expect(ready.next.kind).toBe("dispatch");
    expect(ready.state.team?.ready).toBe(true);
    const again = await advance(h, "run1", { type: "tick" }, { spec, leadSessionId: "sol-other" });
    expect(again.next.kind).toBe("setup");
    expect(again.state.team?.ready).toBe(false);
  });

  it("re-setups on the first advance after a plugin boot change", async () => {
    const { h, spec } = await boot();
    const ready = await setupOk(h, spec);
    expect(ready.state.team?.ready).toBe(true);
    await withRun(h, "run1", (raw) => {
      const s = raw as unknown as GraphRunState;
      if (s.team) s.team = { ...s.team, plugin_boot_id: "boot-previous" };
    });
    const again = await advance(h, "run1", { type: "tick" }, { spec, pluginBootId: "boot-current" });
    expect(again.next.kind).toBe("setup");
    expect(again.state.team?.ready).toBe(false);
  });
});
