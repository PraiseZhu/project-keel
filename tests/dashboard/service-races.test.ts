import { describe, expect, it } from "vitest";
import { makeContext } from "../../src/main/context.ts";
import { refreshDashboard, restoreDashboard, updateDashboardLocal } from "../../src/main/dashboard/service.ts";
import { applyDashboardMessage, emptyDashboard, type DashboardStore } from "../../src/panel/dashboard-model.ts";
import type { BoardCard, BoardSnapshot, PullPage, RemotePull } from "../../src/shared/dashboard.ts";
import { fakeHost, type FakeHost } from "../helpers/fakeHost.ts";
import { makePull, makeRun, saveRun } from "./fixtures.ts";

const profile = { lanes: [], boardRepos: [], routingPath: null, plansDir: null };

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function page(rows: RemotePull[], overrides: Partial<PullPage> = {}) {
  return { ok: true, result: { owner: "demo", rows, total: rows.length, nextCursor: null, ...overrides } };
}

function holdNextRead(host: FakeHost, path: RegExp) {
  const reached = latch();
  const waiting = latch();
  const original = host.fs.bind(host);
  let held = false;
  host.fs = async (request) => {
    if (!held && request.op === "read" && path.test(request.path ?? "")) {
      held = true;
      const response = await original(request);
      reached.release();
      await waiting.promise;
      return response;
    }
    return original(request);
  };
  return { reached: reached.promise, release: waiting.release };
}

function replay(host: FakeHost, store: DashboardStore, from = 0, panelId = "panel") {
  for (const message of host.broadcasts.slice(from)) applyDashboardMessage(store, message, panelId);
}

function expectFrame(host: FakeHost, from: number, snapshot: BoardSnapshot, previousGeneration?: number, target?: string) {
  const packets = (host.broadcasts.slice(from) as Record<string, unknown>[])
    .filter((message) => ["dashboard-begin", "dashboard-page", "dashboard-end"].includes(String(message.type)));
  expect(packets.length).toBeGreaterThanOrEqual(2);
  const begin = packets[0]!;
  const end = packets.at(-1)!;
  expect(begin).toMatchObject({ type: "dashboard-begin", rowCount: snapshot.rows.length });
  expect(end).toMatchObject({ type: "dashboard-end", rowCount: snapshot.rows.length });
  expect(Number.isSafeInteger(begin.generation)).toBe(true);
  expect(begin.epoch).toEqual(expect.any(String));
  const generation = begin.generation as number;
  if (previousGeneration !== undefined) expect(generation).toBeGreaterThan(previousGeneration);
  for (const packet of packets) {
    expect(packet).toMatchObject({ generation, epoch: begin.epoch, scope: snapshot.scope, owner: snapshot.owner });
    expect(packet.target).toBe(target);
  }
  const { rows, ...metadata } = snapshot;
  expect(begin).toMatchObject(metadata);
  expect(end).toMatchObject(metadata);
  const pages = packets.slice(1, -1);
  expect(pages.every((packet) => packet.type === "dashboard-page")).toBe(true);
  expect(pages.flatMap((packet) => packet.rows as BoardCard[])).toEqual(rows);
  expect(pages.every((packet) => new TextEncoder().encode(JSON.stringify(packet)).length < 48 * 1024)).toBe(true);
  return { packets, generation };
}

describe("dashboard service race regressions", () => {
  it("T01 rejects a late local projection after a newer scan confirms MERGED and a new HEAD", async () => {
    let current = makePull(1, { title: "old open state" });
    const host = fakeHost({ node: async () => page([current]) });
    const ctx = makeContext(host, "race", profile);
    await refreshDashboard(ctx, { scope: "all" });
    const store = emptyDashboard("all");
    replay(host, store);
    const delayed = holdNextRead(host, /^handoff\//);
    const local = updateDashboardLocal(ctx, "all", current.key);
    await delayed.reached;
    current = { ...current, state: "MERGED", headSha: "b".repeat(40), title: "new merged state" };
    host.clock.t += 31_000;
    const start = host.broadcasts.length;
    const snapshot = await refreshDashboard(ctx, { scope: "all" });
    replay(host, store, start);
    const beforeLocal = host.broadcasts.length;
    delayed.release();
    await local;
    replay(host, store, beforeLocal);
    expect(snapshot.rows[0]).toMatchObject(current);
    expect(store.rows.get(current.key)).toMatchObject(current);
    expect(host.broadcasts.slice(beforeLocal)).toEqual([]);
    expect(host.nodeCalls.map((call) => call.method)).toEqual(["pr/board", "pr/board"]);
  });

  it("T01 rejects local work from before a new scan even while its GitHub response is pending", async () => {
    const reached = latch();
    const waiting = latch();
    let scanning = false;
    let current = makePull();
    const host = fakeHost({ node: async () => {
      if (scanning) { reached.release(); await waiting.promise; }
      return page([current]);
    } });
    const ctx = makeContext(host, "race", profile);
    await refreshDashboard(ctx);
    const delayed = holdNextRead(host, /^handoff\//);
    const local = updateDashboardLocal(ctx, "open", current.key);
    await delayed.reached;
    scanning = true;
    current = { ...current, headSha: "b".repeat(40) };
    host.clock.t += 31_000;
    const refreshing = refreshDashboard(ctx);
    await reached.promise;
    const beforeLocal = host.broadcasts.length;
    delayed.release();
    await local;
    const lateMessages = host.broadcasts.slice(beforeLocal);
    waiting.release();
    const snapshot = await refreshing;
    expect(lateMessages).toEqual([]);
    expect(snapshot.rows[0]).toMatchObject(current);
  });

  it("T02 never relabels Alice's delayed local card as Bob's current card", async () => {
    let owner = "alice";
    let current = makePull(1, { author: owner, title: "alice snapshot" });
    const host = fakeHost({ node: async () => page([current], { owner }) });
    const ctx = makeContext(host, "race", profile);
    await refreshDashboard(ctx);
    const delayed = holdNextRead(host, /^handoff\//);
    const local = updateDashboardLocal(ctx, "open", current.key);
    await delayed.reached;
    owner = "bob";
    current = { ...current, author: owner, title: "bob current snapshot", headSha: "b".repeat(40) };
    host.clock.t += 31_000;
    const snapshot = await refreshDashboard(ctx);
    const beforeLocal = host.broadcasts.length;
    delayed.release();
    await local;
    expect(snapshot.owner).toBe("bob");
    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0]).toMatchObject(current);
    expect(host.broadcasts.slice(beforeLocal)).toEqual([]);
    const start = host.broadcasts.length;
    await restoreDashboard(ctx, "open", "new-panel");
    const store = emptyDashboard();
    replay(host, store, start, "new-panel");
    expect(store.owner).toBe("bob");
    expect([...store.rows.values()]).toEqual(snapshot.rows);
  });

  it.each(["before identity", "after identity"] as const)("T04 discards stale disk restore when a scan starts %s confirmation", async (timing) => {
    const oldHost = fakeHost({ node: async () => page([makePull(1)], { owner: "alice" }) });
    await refreshDashboard(makeContext(oldHost, "old", profile));
    const remoteReached = latch();
    const remoteWaiting = latch();
    const current = makePull(2, { author: "bob" });
    const host = fakeHost({ node: async () => {
      if (timing === "before identity") { remoteReached.release(); await remoteWaiting.promise; }
      return page([current], { owner: "bob" });
    } });
    host.files.set("board/dashboard-open.json", oldHost.files.get("board/dashboard-open.json")!);
    const ctx = makeContext(host, "race", profile);
    const disk = holdNextRead(host, /^board\/dashboard-open\.json$/);
    const restoring = restoreDashboard(ctx, "open", "panel");
    await disk.reached;
    const handoff = timing === "after identity" ? holdNextRead(host, /^handoff\//) : undefined;
    const refreshing = refreshDashboard(ctx);
    await (handoff?.reached ?? remoteReached.promise);
    const beforeRestore = host.broadcasts.length;
    disk.release();
    await restoring;
    const restoredMessages = host.broadcasts.slice(beforeRestore);
    handoff?.release();
    remoteWaiting.release();
    const snapshot = await refreshing;
    expect(restoredMessages).toEqual([]);
    expect(snapshot).toMatchObject({ owner: "bob", connection: "live", complete: true });
    expect(snapshot.rows.map((row) => row.key)).toEqual([current.key]);
    const store = emptyDashboard();
    replay(host, store);
    expect(store.owner).toBe("bob");
    expect([...store.rows.values()]).toEqual(snapshot.rows);
    expect(host.nodeCalls.map((call) => call.method)).toEqual(["pr/board"]);
  });

  it("T08 keeps a local-read warning through the whole scan and clears it after a successful full rescan", async () => {
    const first = makePull(1);
    const second = makePull(2);
    const host = fakeHost({ node: async (_method, args) => args.cursor
      ? page([second], { total: 2 }) : page([first], { total: 2, nextCursor: "next" }) });
    const path = "handoff/sample__keel__1.json";
    host.files.set(path, "{broken-json");
    const ctx = makeContext(host, "race", profile);
    const initial = await refreshDashboard(ctx);
    expect(initial).toMatchObject({ connection: "partial", complete: false });
    expect(initial.error).toEqual(expect.any(String));
    host.clock.t += 650;
    const completed = await refreshDashboard(ctx);
    expect(completed).toMatchObject({ connection: "partial", complete: true, error: initial.error });
    expect(host.files.get(path)).toBe("{broken-json");
    host.files.delete(path);
    host.clock.t += 31_000;
    await refreshDashboard(ctx);
    host.clock.t += 650;
    const recovered = await refreshDashboard(ctx);
    expect(recovered).toMatchObject({ connection: "live", complete: true });
    expect(recovered.error).toBeUndefined();
    expect(recovered.rows.map((row) => row.key)).toEqual([first.key, second.key]);
    expect(host.nodeCalls.map((call) => call.method)).toEqual(Array(4).fill("pr/board"));
  });

  it("T13 keeps newer same-key local progress in the service snapshot and in newly restored panels", async () => {
    const pull = makePull();
    const host = fakeHost({ node: async () => page([pull]) });
    const ctx = makeContext(host, "race", profile);
    const run = makeRun(pull, "implement", host.now());
    const dispatchKey = run.nodes.implement!.dispatch_key!;
    run.progress = { nodeId: "implement", dispatchKey, step: 3, at: host.now() };
    saveRun(host, run);
    const snapshot = await refreshDashboard(ctx);
    const oldPanel = emptyDashboard();
    replay(host, oldPanel);
    const delayed = holdNextRead(host, /^handoff\//);
    const older = updateDashboardLocal(ctx, "open", pull.key);
    await delayed.reached;
    host.clock.t += 1000;
    run.progress = { nodeId: "implement", dispatchKey, step: 4, at: host.now() };
    run.updated_at = host.now();
    saveRun(host, run);
    const start = host.broadcasts.length;
    await updateDashboardLocal(ctx, "open", pull.key);
    replay(host, oldPanel, start);
    expect(oldPanel.rows.get(pull.key)?.step.index).toBe(3);
    const beforeOlder = host.broadcasts.length;
    delayed.release();
    await older;
    replay(host, oldPanel, beforeOlder);
    expect(snapshot.rows[0]?.step.index).toBe(3);
    expect(snapshot.rows[0]?.activityAt).toBe(host.now());
    expect(host.broadcasts.slice(beforeOlder)).toEqual([]);
    const beforeRestore = host.broadcasts.length;
    await restoreDashboard(ctx, "open", "new-panel");
    const newPanel = emptyDashboard();
    replay(host, newPanel, beforeRestore, "new-panel");
    expect(newPanel.rows.get(pull.key)).toEqual(oldPanel.rows.get(pull.key));
    expectFrame(host, beforeRestore, snapshot, undefined, "new-panel");
    expect(host.nodeCalls.map((call) => call.method)).toEqual(["pr/board"]);
  });
});

describe("dashboard full-frame recovery protocol", () => {
  it("publishes all accumulated rows in a fresh frame after every remote page", async () => {
    const pulls = Array.from({ length: 23 }, (_value, index) => makePull(index + 1));
    const host = fakeHost({ node: async (_method, args) => args.cursor === "last"
      ? page(pulls.slice(22), { total: pulls.length })
      : args.cursor === "next" ? page(pulls.slice(21, 22), { total: pulls.length, nextCursor: "last" })
        : page(pulls.slice(0, 21), { total: pulls.length, nextCursor: "next" }) });
    const ctx = makeContext(host, "frames", profile);
    let generation: number | undefined;
    for (const rowCount of [21, 22, 23]) {
      const start = host.broadcasts.length;
      const snapshot = await refreshDashboard(ctx);
      expect(snapshot.rows).toHaveLength(rowCount);
      expect(snapshot.total).toBe(pulls.length);
      const frame = expectFrame(host, start, snapshot, generation);
      generation = frame.generation;
      const latePanel = emptyDashboard();
      replay(host, latePanel, start);
      expect([...latePanel.rows.values()]).toEqual(snapshot.rows);
      expect(latePanel.complete).toBe(snapshot.complete);
      host.clock.t += 650;
    }
  });

  it("frames an empty completed snapshot with zero rows and no page messages", async () => {
    const host = fakeHost({ node: async () => page([]) });
    const snapshot = await refreshDashboard(makeContext(host, "empty", profile));
    const frame = expectFrame(host, 0, snapshot);
    expect(frame.packets.map((packet) => packet.type)).toEqual(["dashboard-begin", "dashboard-end"]);
    expect(snapshot).toMatchObject({ rows: [], total: 0, complete: true, connection: "live" });
  });

  it.each([
    { reason: "500 ms throttle", delta: 100, force: true, nextCursor: "next", quota: false },
    { reason: "completed scan cache", delta: 1000, force: false, nextCursor: null, quota: false },
    { reason: "quota backoff", delta: 1000, force: true, nextCursor: "next", quota: true },
  ])("replays a full frame during $reason without inventing GitHub freshness", async ({ delta, force, nextCursor, quota }) => {
    const host = fakeHost({ node: async () => page([makePull()], {
      total: nextCursor ? 2 : 1, nextCursor,
      ...(quota ? { remaining: 4, resetAt: new Date(host.now() + 90_000).toISOString() } : {}),
    }) });
    const ctx = makeContext(host, "cached", profile);
    const snapshot = await refreshDashboard(ctx);
    const initial = expectFrame(host, 0, snapshot);
    const freshness = { at: snapshot.at, lastSuccessAt: snapshot.lastSuccessAt };
    const calls = host.nodeCalls.length;
    host.clock.t += delta;
    const start = host.broadcasts.length;
    const cached = await refreshDashboard(ctx, { force });
    expect(cached).toEqual(snapshot);
    expect(cached).toMatchObject(freshness);
    expect(host.nodeCalls).toHaveLength(calls);
    const frame = expectFrame(host, start, cached, initial.generation);
    expect(frame.packets[0]).toMatchObject(freshness);
    expect(frame.packets.at(-1)).toMatchObject(freshness);
    const store = emptyDashboard();
    replay(host, store, start);
    expect([...store.rows.values()]).toEqual(snapshot.rows);
    expect(store.lastSuccessAt).toBe(freshness.lastSuccessAt);
  });

  it.each(["dashboard-begin", "dashboard-page", "dashboard-end"])("recovers a lost %s via a cache frame and rejects the delayed old packet", async (missingType) => {
    let pulls = Array.from({ length: 21 }, (_value, index) => makePull(index + 1));
    const host = fakeHost({ node: async () => page(pulls) });
    const ctx = makeContext(host, "recovery", profile);
    await refreshDashboard(ctx);
    const store = emptyDashboard();
    replay(host, store);
    pulls = pulls.map((pull) => ({ ...pull, title: `new ${pull.number}`, headSha: "b".repeat(40) }));
    host.clock.t += 31_000;
    const start = host.broadcasts.length;
    const snapshot = await refreshDashboard(ctx);
    const incomplete = expectFrame(host, start, snapshot, store.generation);
    const missing = incomplete.packets.findIndex((packet) => packet.type === missingType);
    expect(missing).toBeGreaterThanOrEqual(0);
    for (const [index, packet] of incomplete.packets.entries()) {
      if (index !== missing) applyDashboardMessage(store, packet, "panel");
    }
    const calls = host.nodeCalls.length;
    const freshness = { at: snapshot.at, lastSuccessAt: snapshot.lastSuccessAt };
    host.clock.t += 100;
    const beforeRecovery = host.broadcasts.length;
    const recovered = await refreshDashboard(ctx, { force: true });
    expectFrame(host, beforeRecovery, recovered, incomplete.generation);
    expect(recovered).toMatchObject(freshness);
    expect(host.nodeCalls).toHaveLength(calls);
    replay(host, store, beforeRecovery);
    expect(store).toMatchObject({ complete: true, connection: "live", owner: snapshot.owner, ...freshness });
    expect([...store.rows.values()]).toEqual(snapshot.rows);
    expect(applyDashboardMessage(store, incomplete.packets[missing], "panel")).toBe(false);
    expect([...store.rows.values()]).toEqual(snapshot.rows);
  });

  it("publishes retained rows and unchanged last success in a complete frame when a later page fails", async () => {
    let rescan = false;
    const host = fakeHost({ node: async (_method, args) => {
      if (!rescan) return page([makePull(1), makePull(2)]);
      if (args.cursor) return { ok: false, message: "GH_ERROR: offline fixture" };
      return page([makePull(1, { title: "new title" })], { total: 2, nextCursor: "next" });
    } });
    const ctx = makeContext(host, "failed-frame", profile);
    await refreshDashboard(ctx);
    rescan = true;
    host.clock.t += 31_000;
    const start = host.broadcasts.length;
    const partial = await refreshDashboard(ctx);
    const frame = expectFrame(host, start, partial);
    host.clock.t += 650;
    const beforeFailure = host.broadcasts.length;
    const failed = await refreshDashboard(ctx);
    expect(failed).toMatchObject({ connection: "offline", complete: false, lastSuccessAt: partial.lastSuccessAt });
    expect(failed.rows).toHaveLength(2);
    expectFrame(host, beforeFailure, failed, frame.generation);
    const store = emptyDashboard();
    replay(host, store, beforeFailure);
    expect([...store.rows.values()]).toEqual(failed.rows);
  });
});
