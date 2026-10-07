import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONCURRENT_RUNS,
  Program,
  shouldAdvanceFrontier,
  type OrchClient,
  type RunReport,
  type WorkerLimit,
} from "../../src/main/graph/program.ts";
import type { Frontier, InboxPointer, OpenGate, Unit } from "../../src/node/orch/store.ts";

function memoryOrch(): OrchClient & { units: Unit[] } {
  const units: Unit[] = [];
  const gates: OpenGate[] = [];
  let inbox: InboxPointer[] = [];
  let frontier: Frontier = { generation: 0, prs: [], lowestUnmerged: null };
  const orch: OrchClient & { units: Unit[] } = {
    units,
    async unitsAdd(params) {
      if (units.some((u) => u.id === params.id)) throw new Error(`exists ${params.id}`);
      const row: Unit = { id: params.id, track: params.track, state: "pending", branch: "", pr: "", sha: "", brief: params.brief ?? "" };
      units.push(row);
      return row;
    },
    async unitsSet(params) {
      const i = units.findIndex((u) => u.id === params.id);
      if (i < 0) throw new Error(`missing ${params.id}`);
      const old = units[i]!;
      const row: Unit = {
        ...old,
        state: params.state,
        branch: params.branch ?? old.branch,
        pr: params.pr === undefined ? old.pr : String(params.pr),
        sha: params.sha ?? old.sha,
      };
      units[i] = row;
      return row;
    },
    async unitsList(params = {}) {
      return units.filter((u) => (!params.state || u.state === params.state) && (!params.track || u.track === params.track));
    },
    async inboxPush(params) {
      inbox.push({ ts: "t", agent: params.agent, unit: params.unit, status: params.status, report: params.report ?? "" });
      return {};
    },
    async inboxDrain() {
      const rows = inbox;
      inbox = [];
      return rows;
    },
    async gatesPark(params) {
      const g: OpenGate = { kind: "open", ...params };
      const i = gates.findIndex((x) => x.id === g.id);
      if (i < 0) gates.push(g);
      else gates[i] = g;
      return g;
    },
    async gatesList() {
      return [...gates];
    },
    async frontierShow() {
      return frontier;
    },
    async frontierSet(value) {
      frontier = value;
      return frontier;
    },
  };
  return orch;
}

function program(opts: {
  orch?: OrchClient;
  reports?: Record<string, RunReport | (() => RunReport)>;
  fail?: string[];
  startFail?: string[];
  workers?: WorkerLimit;
  window?: number;
  started?: string[];
}) {
  const orch = opts.orch ?? memoryOrch();
  const started = opts.started ?? [];
  const p = new Program({
    orch,
    concurrentRuns: opts.window ?? DEFAULT_CONCURRENT_RUNS,
    workerLimit: () => opts.workers ?? { hard_limit: 32, remaining_slots: 32 },
    async startRun({ unit, run_id }) {
      if ((opts.startFail ?? []).includes(unit.id)) throw new Error("invalid repo_dir");
      started.push(unit.id);
      return { run_id };
    },
    async advanceRun({ unit, run_id }) {
      if ((opts.fail ?? []).includes(unit.id)) throw new Error("boom");
      const spec = opts.reports?.[unit.id];
      const report = typeof spec === "function" ? spec() : spec;
      return report ?? { run_id, unit_id: unit.id, status: "running", head_sha: unit.sha || "sha0" };
    },
  });
  return { p, orch, started };
}

describe("rolling window", () => {
  it("starts at most concurrentRuns (default 4) and leaves the rest pending", async () => {
    const { p, orch, started } = program({ window: 4 });
    for (let i = 1; i <= 6; i++) await p.addUnit({ id: `u${i}`, track: "build" });
    const tick = await p.tick();
    expect(tick.started).toEqual(["u1", "u2", "u3", "u4"]);
    expect(tick.queued_window).toEqual(["u5", "u6"]);
    expect(started).toEqual(["u1", "u2", "u3", "u4"]);
    expect((await orch.unitsList({ state: "pending" })).map((u) => u.id)).toEqual(["u5", "u6"]);
    expect((await orch.unitsList({ state: "running" })).map((u) => u.id)).toEqual(["u1", "u2", "u3", "u4"]);
  });
});

describe("worker slot queue", () => {
  it("queues extra units when remaining_slots is 0 rather than failing them", async () => {
    const { p, orch } = program({ workers: { hard_limit: 8, remaining_slots: 1 }, window: 4 });
    await p.addUnit({ id: "a", track: "t" });
    await p.addUnit({ id: "b", track: "t" });
    await p.addUnit({ id: "c", track: "t" });
    const tick = await p.tick();
    expect(tick.started).toEqual(["a"]);
    expect(tick.queued_workers).toEqual(["b", "c"]);
    expect(tick.stopped).toEqual([]);
    expect((await orch.unitsList({ state: "pending" })).map((u) => u.id)).toEqual(["b", "c"]);
  });
});

describe("frontier", () => {
  it("advances only on merged or a new head, not on a same-sha running report", async () => {
    expect(shouldAdvanceFrontier({ run_id: "r", unit_id: "u", status: "running", head_sha: "h1" }, "")).toBe("new_head");
    expect(shouldAdvanceFrontier({ run_id: "r", unit_id: "u", status: "done", merged: true, head_sha: "h1" }, "h1")).toBe("merged");
    expect(shouldAdvanceFrontier({ run_id: "r", unit_id: "u", status: "running", head_sha: "h1" }, "h1")).toBe(null);

    const orch = memoryOrch();
    const { p } = program({
      orch,
      reports: { u1: { run_id: "run-u1", unit_id: "u1", status: "running", head_sha: "aaa" } },
    });
    await p.addUnit({ id: "u1", track: "t", pr: 10 });
    const first = await p.tick();
    expect(first.frontier_advanced).toBe(true);
    expect((await orch.frontierShow()).generation).toBe(1);
    const second = await p.tick();
    expect(second.frontier_advanced).toBe(false);
    expect((await orch.frontierShow()).generation).toBe(1);

    const { p: p2, orch: o2 } = program({
      orch: memoryOrch(),
      reports: { u1: { run_id: "run-u1", unit_id: "u1", status: "done", merged: true, head_sha: "bbb" } },
    });
    await p2.addUnit({ id: "u1", track: "t", pr: 11 });
    const merged = await p2.tick();
    expect(merged.frontier_advanced).toBe(true);
    expect((await o2.frontierShow()).prs[0]).toMatchObject({ pr: 11, state: "MERGED", sha: "bbb" });
  });
});

describe("human gates", () => {
  it("parks every blocked unit and returns them in one batch", async () => {
    const { p } = program({
      reports: {
        a: { run_id: "run-a", unit_id: "a", status: "blocked", human_gate: { id: "g-a", question: "A?", options: "yes|no", defaultAnswer: "no" } },
        b: { run_id: "run-b", unit_id: "b", status: "blocked", human_gate: { id: "g-b", question: "B?", options: "yes|no", defaultAnswer: "no" } },
      },
    });
    await p.addUnit({ id: "a", track: "t" });
    await p.addUnit({ id: "b", track: "t" });
    const tick = await p.tick();
    expect([...tick.blocked].sort()).toEqual(["a", "b"]);
    expect(tick.human_gates.map((g) => g.id).sort()).toEqual(["g-a", "g-b"]);
    expect(tick.human_gates).toHaveLength(2);
  });
});

describe("failure isolation", () => {
  it("stopping one unit does not stop siblings", async () => {
    const { p, orch } = program({
      fail: ["bad"],
      reports: { ok: { run_id: "run-ok", unit_id: "ok", status: "done", head_sha: "z" } },
    });
    await p.addUnit({ id: "bad", track: "t" });
    await p.addUnit({ id: "ok", track: "t" });
    const tick = await p.tick();
    expect(tick.stopped).toEqual(["bad"]);
    expect(tick.errors).toEqual([{ unit: "bad", phase: "advance", message: "boom" }]);
    expect((await orch.unitsList()).find((u) => u.id === "ok")?.state).toBe("done");
    expect((await orch.unitsList()).find((u) => u.id === "bad")?.state).toBe("stopped");
  });

  it("a startRun throw stops only that unit and still advances siblings", async () => {
    const { p, orch } = program({
      startFail: ["broken"],
      reports: { ok: { run_id: "run-ok", unit_id: "ok", status: "done", head_sha: "z" } },
    });
    await p.addUnit({ id: "broken", track: "t" });
    await p.addUnit({ id: "ok", track: "t" });
    const tick = await p.tick();
    expect(tick.started).toEqual(["ok"]);
    expect(tick.stopped).toEqual(["broken"]);
    expect(tick.errors).toEqual([{ unit: "broken", phase: "start", message: "invalid repo_dir" }]);
    expect((await orch.unitsList()).find((u) => u.id === "ok")?.state).toBe("done");
    expect((await orch.unitsList()).find((u) => u.id === "broken")?.state).toBe("stopped");
  });
});

describe("inbox is a wake hint", () => {
  it("does not copy inbox status onto the unit; only advanceRun can mark done", async () => {
    let status: RunReport["status"] = "running";
    const orch = memoryOrch();
    const { p } = program({
      orch,
      reports: { u1: () => ({ run_id: "run-u1", unit_id: "u1", status, head_sha: "h1" }) },
    });
    await p.addUnit({ id: "u1", track: "t" });
    await p.tick();
    expect((await orch.unitsList()).find((u) => u.id === "u1")?.state).toBe("running");
    await orch.inboxPush({ agent: "w", unit: "u1", status: "done" });
    await orch.inboxPush({ agent: "w", unit: "u1", status: "blocked" });
    const afterHint = await p.tick();
    expect((await orch.unitsList()).find((u) => u.id === "u1")?.state).toBe("running");
    expect(afterHint.blocked).toEqual([]);
    expect(afterHint.human_gates).toEqual([]);
    status = "done";
    const afterAdvance = await p.tick();
    expect(afterAdvance.advanced).toEqual(["u1"]);
    expect((await orch.unitsList()).find((u) => u.id === "u1")?.state).toBe("done");
  });
});

describe("restart restore", () => {
  it("a new Program on the same orch does not re-start running units", async () => {
    const orch = memoryOrch();
    const started: string[] = [];
    const first = program({ orch, started, window: 4 });
    for (let i = 1; i <= 5; i++) await first.p.addUnit({ id: `u${i}`, track: "t" });
    await first.p.tick();
    expect(started).toEqual(["u1", "u2", "u3", "u4"]);
    const restored = await first.p.restore();
    expect(restored.filter((u) => u.state === "running")).toHaveLength(4);
    const started2: string[] = [];
    const second = program({ orch, started: started2, window: 4 });
    await second.p.restore();
    const tick = await second.p.tick();
    expect(started2).toEqual([]);
    expect(tick.started).toEqual([]);
    expect(tick.queued_window).toEqual(["u5"]);
    expect([...tick.advanced].sort()).toEqual(["u1", "u2", "u3", "u4"]);
  });
});
