import { describe, expect, it } from "vitest";
import { makeContext } from "../../src/main/context.ts";
import { runTool } from "../../src/main/dispatch.ts";
import { loadGraphStates } from "../../src/main/graph-snapshot.ts";
import { countWaitCiRuns, isWaitCiRun } from "../../src/main/graph/poll.ts";
import type { GraphRunState } from "../../src/main/graph/state.ts";
import { flushNudgeCardOnToolCall } from "../../src/main/host-bridge.ts";
import { graphStatePath } from "../../src/main/store/runs.ts";
import { fakeHost } from "../helpers/fakeHost.ts";

const UNKNOWN_RUN_ID = "summary";
const PLACEHOLDER = {
  run_id: UNKNOWN_RUN_ID,
  nudge_card_call_ids: ["tc_opaque-call"],
  nudge_pending_card: false,
};

function nodelessPlaceholder(): GraphRunState {
  return PLACEHOLDER as unknown as GraphRunState;
}

describe("unknown run_id must not persist a nodeless placeholder", () => {
  it("keel_status with a missing run_id does not write graph-state.json", async () => {
    const h = fakeHost();
    const status = await runTool(makeContext(h, "c-status"), "keel_status", { run_id: UNKNOWN_RUN_ID });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect((status.result as { runs: unknown[] }).runs).toEqual([]);

    await flushNudgeCardOnToolCall({
      host: h,
      send: () => {},
      tool: "keel_status",
      callId: "tc_status-unknown",
      args: { run_id: UNKNOWN_RUN_ID },
      result: status.result,
    });

    expect(h.files.has(graphStatePath(UNKNOWN_RUN_ID))).toBe(false);
    expect([...h.files.keys()].some((k) => k.startsWith(`runs/${UNKNOWN_RUN_ID}/`))).toBe(false);
  });
});

describe("nodeless placeholder must be skipped, not crash wait/status/poll", () => {
  it("reproduces isWaitCiRun throwing on missing nodes, then treats it as a non-graph run", () => {
    const placeholder = nodelessPlaceholder();
    expect(placeholder.nodes).toBeUndefined();
    expect(() => isWaitCiRun(placeholder)).not.toThrow();
    expect(isWaitCiRun(placeholder)).toBe(false);
    expect(() => countWaitCiRuns([placeholder])).not.toThrow();
    expect(countWaitCiRuns([placeholder])).toBe(0);
  });

  it("keel_wait does not crash when runs/ already has a nodeless placeholder", async () => {
    const h = fakeHost();
    h.files.set(graphStatePath(UNKNOWN_RUN_ID), JSON.stringify(PLACEHOLDER));
    const states = await loadGraphStates(h);
    expect(states.some((r) => r.run_id === UNKNOWN_RUN_ID)).toBe(true);

    const r = await runTool(makeContext(h, "c-wait"), "keel_wait", { run_id: UNKNOWN_RUN_ID, max_minutes: 1 });
    expect(JSON.stringify(r)).not.toMatch(/Cannot read properties of undefined/);
    if (!r.ok) expect(r.errorCode).not.toBe("REQUEST_FAILED");
  });

  it("keel_status skips a nodeless placeholder instead of listing it as a graph run", async () => {
    const h = fakeHost();
    h.files.set(graphStatePath(UNKNOWN_RUN_ID), JSON.stringify(PLACEHOLDER));
    const r = await runTool(makeContext(h, "c-list"), "keel_status", {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const runs = (r.result as { runs: { run_id: string }[] }).runs;
    expect(runs.some((x) => x.run_id === UNKNOWN_RUN_ID)).toBe(false);
  });
});
