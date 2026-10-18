import { describe, expect, it } from "vitest";
import { recordDashboardProgress } from "../../src/main/dashboard/progress.ts";
import { makeContext } from "../../src/main/context.ts";
import { fakeHost } from "../helpers/fakeHost.ts";
import { makePull, makeRun, saveRun } from "./fixtures.ts";

const profile = { lanes: [], boardRepos: [], routingPath: null, plansDir: null };
function setup() {
  const host = fakeHost(); const run = makeRun(makePull(), "implement", host.now()); saveRun(host, run);
  const args = { run_id: run.run_id, dispatch_key: run.nodes.implement!.dispatch_key, step: 4 };
  const context = makeContext(host, "progress", profile, undefined, "lead");
  const path = `runs/${run.run_id}/graph-state.json`;
  return { host, run, args, context, path };
}

describe("structured workflow step reports", () => {
  it("records a matching active step without dispatching or completing the node", async () => {
    const { host, run, args, context, path } = setup(); host.clock.t += 10_000;
    const result = await recordDashboardProgress(context, args);
    expect(result).toMatchObject({ recorded: true, progress: { step: 4, dispatchKey: args.dispatch_key, nodeId: "implement" } });
    expect(result).not.toHaveProperty("next");
    const after = JSON.parse(host.files.get(path)!);
    expect(after.cursor).toBe(run.cursor); expect(after.status).toBe(run.status); expect(after.nodes).toEqual(run.nodes);
  });
  it("rejects another session, an unsupported step and stale dispatch without changing data", async () => {
    const { host, args, context, path } = setup(); const before = host.files.get(path);
    await expect(recordDashboardProgress(makeContext(host, "other", profile, undefined, "other"), args)).rejects.toMatchObject({ code: "NOT_LEAD" });
    await expect(recordDashboardProgress(context, { ...args, step: 1 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(recordDashboardProgress(context, { ...args, step: 99 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(recordDashboardProgress(context, { ...args, dispatch_key: "old" })).rejects.toMatchObject({ code: "DISPATCH_KEY_STALE" });
    expect(host.files.get(path)).toBe(before);
  });
  it("does not create a missing run or accept terminal node reports", async () => {
    const { host, args, context, path, run } = setup();
    await expect(recordDashboardProgress(context, { ...args, run_id: "missing-run" })).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
    expect(host.files.has("runs/missing-run/graph-state.json")).toBe(false);
    run.status = "done"; saveRun(host, run);
    const before = host.files.get(path);
    await expect(recordDashboardProgress(context, args)).rejects.toMatchObject({ code: "DISPATCH_KEY_STALE" });
    expect(host.files.get(path)).toBe(before);
  });
});
