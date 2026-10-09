import { describe, expect, it } from "vitest";
import { advance } from "../../src/main/graph/interpreter.ts";
import { graphStatePath } from "../../src/main/store/runs.ts";
import { fakeHost } from "../helpers/fakeHost.ts";
import { boot, readState, setupOk } from "./helpers.ts";

describe("graph-state recovery", () => {
  it("Cindy restart after planned persist reuses the same dispatch_key and does not open a second attempt", async () => {
    const { h, spec } = await boot();
    const d = await setupOk(h, spec);
    if (d.next.kind !== "dispatch") throw new Error("dispatch");
    const key = d.next.dispatch_key;
    const label = d.next.create_worker?.label;
    const snapshot = h.files.get(graphStatePath("run1"))!;

    const h2 = fakeHost();
    h2.files.set(graphStatePath("run1"), snapshot);
    h2.clock.t = h.clock.t;
    const again = await advance(h2, "run1", { type: "tick" }, { spec });
    expect(again.next.kind).toBe("dispatch");
    if (again.next.kind !== "dispatch") throw new Error("dispatch");
    expect(again.next.dispatch_key).toBe(key);
    expect(again.next.create_worker?.label).toBe(label);
    expect(readState(h2).nodes.worker?.attempts).toBe(1);
    expect(Object.values(readState(h2).nodes).filter((n) => n.dispatch_state === "planned")).toHaveLength(1);
  });

  it("restart while running does not dispatch a new worker", async () => {
    const { h, spec } = await boot();
    const d = await setupOk(h, spec);
    if (d.next.kind !== "dispatch") throw new Error("dispatch");
    await advance(h, "run1", {
      type: "report",
      phase: "accepted",
      dispatch_key: d.next.dispatch_key,
      worker_id: "w1",
      worker_session_id: "ws1",
      dispatch_outcome: { created: true, delivered: true, queued: false },
    }, { spec });
    const snapshot = h.files.get(graphStatePath("run1"))!;
    const h2 = fakeHost();
    h2.files.set(graphStatePath("run1"), snapshot);
    h2.clock.t = h.clock.t;
    const again = await advance(h2, "run1", { type: "tick" }, { spec });
    expect(again.next.kind).toBe("wait");
    expect(readState(h2).nodes.worker?.attempts).toBe(1);
    expect(readState(h2).nodes.worker?.dispatch_key).toBe(d.next.dispatch_key);
  });
});
