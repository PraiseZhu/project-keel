import { describe, expect, it } from "vitest";
import { refreshDashboard, restoreDashboard, updateDashboardLocal } from "../../src/main/dashboard/service.ts";
import { makeContext } from "../../src/main/context.ts";
import { trackDashboardResult } from "../../src/main/dashboard/registry.ts";
import { fakeHost } from "../helpers/fakeHost.ts";
import { makePull, makeRun, saveRun } from "./fixtures.ts";

const profile = { lanes: [], boardRepos: ["only/one-repo"], routingPath: null, plansDir: null };

describe("dashboard complete enumeration", () => {
  it("reads all pages and repositories, without the old 50/15 caps or PR-number collisions", async () => {
    const rows = Array.from({ length: 123 }, (_value, index) => makePull(index + 1, { repo: index % 2 ? "sample/alpha" : "sample/beta" }));
    rows.push(makePull(1, { repo: "sample/alpha" }));
    const cursors: unknown[] = [];
    const host = fakeHost({ node: async (method, raw) => {
      expect(method).toBe("pr/board");
      const args = raw as { cursor?: string };
      cursors.push(args.cursor);
      const offset = Number(args.cursor ?? 0);
      return { ok: true, result: { owner: "demo", rows: rows.slice(offset, offset + 50), total: rows.length, nextCursor: offset + 50 < rows.length ? String(offset + 50) : null } };
    } });
    const ctx = makeContext(host, "board", profile);
    const first = await refreshDashboard(ctx);
    expect(first).toMatchObject({ complete: false, total: 124 });
    expect(first.rows).toHaveLength(50);
    host.clock.t += 1000;
    await refreshDashboard(ctx);
    host.clock.t += 1000;
    const final = await refreshDashboard(ctx);
    expect(final.complete).toBe(true);
    expect(final.rows).toHaveLength(124);
    expect(new Set(final.rows.map((row) => row.key)).size).toBe(124);
    expect(cursors).toEqual([undefined, "50", "100"]);
    expect(final.rows.some((row) => row.repo === "sample/beta")).toBe(true);
    expect(host.files.has("board/managed.json")).toBe(false);
    expect(host.files.has("board/dashboard-open.json")).toBe(true);
    const packets = host.broadcasts.filter((message: any) => message.type === "dashboard-page");
    expect(packets.length).toBeGreaterThan(3);
    expect(packets.every((message) => new TextEncoder().encode(JSON.stringify(message)).length < 48 * 1024)).toBe(true);
  });

  it("coalesces concurrent refreshes into one GitHub request", async () => {
    let complete!: () => void;
    const wait = new Promise<void>((resolve) => { complete = resolve; });
    let requests = 0;
    const host = fakeHost({ node: async () => { requests++; await wait; return { ok: true, result: { owner: "demo", rows: [makePull()], total: 1, nextCursor: null } }; } });
    const ctx = makeContext(host, "board", profile);
    const first = refreshDashboard(ctx), second = refreshDashboard(ctx);
    complete();
    const results = await Promise.all([first, second]);
    expect(requests).toBe(1);
    expect(results[0]).toBe(results[1]);
  });

  it("retains older unvisited cards when a later page fails", async () => {
    let round = 0;
    const host = fakeHost({ node: async (_method, args: any) => {
      if (round === 0) return { ok: true, result: { owner: "demo", rows: [makePull(1), makePull(2)], total: 2, nextCursor: null } };
      if (!args.cursor) return { ok: true, result: { owner: "demo", rows: [makePull(1, { title: "new title" })], total: 2, nextCursor: "page-2" } };
      return { ok: false, message: "GH_ERROR: network unavailable" };
    } });
    const ctx = makeContext(host, "board", profile);
    await refreshDashboard(ctx);
    round = 1; host.clock.t += 31_000;
    await refreshDashboard(ctx);
    host.clock.t += 1000;
    const failed = await refreshDashboard(ctx);
    expect(failed.complete).toBe(false);
    expect(failed.error).toContain("同步失败");
    expect(failed.rows).toHaveLength(2);
    expect(failed.rows.find((row) => row.number === 1)?.title).toBe("new title");
    expect(failed.rows.some((row) => row.number === 2)).toBe(true);
  });

  it("does not mix accounts across pages or reuse another account's cached rows", async () => {
    let account = "alice";
    const host = fakeHost({ node: async (_method, args: any) => ({ ok: true, result: { owner: account, rows: [makePull(account === "alice" ? 1 : 2, { author: account })], total: 2, nextCursor: args.cursor ? null : "next" } }) });
    const ctx = makeContext(host, "board", profile);
    await refreshDashboard(ctx);
    account = "bob"; host.clock.t += 1000;
    const denied = await refreshDashboard(ctx);
    expect(denied.rows).toEqual([]);
    expect(denied.owner).toBe("");
    expect(denied.error).toContain("账号已变更");
    host.clock.t += 31_000;
    const restarted = await refreshDashboard(ctx);
    expect(restarted.owner).toBe("bob");
    expect(restarted.rows.every((row) => row.author === "bob")).toBe(true);
  });

  it("rejects repeated cursors as incomplete and backs off instead of looping", async () => {
    let requests = 0;
    const host = fakeHost({ node: async () => { requests++; return { ok: true, result: { owner: "demo", rows: [makePull(requests)], total: 50, nextCursor: "repeat" } }; } });
    const ctx = makeContext(host, "board", profile);
    await refreshDashboard(ctx); host.clock.t += 1000;
    const failed = await refreshDashboard(ctx);
    expect(failed).toMatchObject({ complete: false });
    expect(failed.error).toContain("BOARD_CURSOR_LOOP");
    expect(failed.rows).toHaveLength(2);
    await refreshDashboard(ctx, { force: true });
    expect(requests).toBe(2);
  });

  it("adds recorded managed PRs outside authored results and keeps inaccessible references visible", async () => {
    const host = fakeHost({ node: async (method, raw: any) => {
      if (method === "pr/board") return { ok: true, result: { owner: "demo", rows: [makePull(1)], total: 1, nextCursor: null } };
      if (raw.number === 2) return { ok: true, result: makePull(2, { author: "teammate" }) };
      return { ok: false, message: "BOARD_PR_UNAVAILABLE: private" };
    } });
    host.files.set("board/managed.json", JSON.stringify({ version: 1, rows: [2, 3].map((number) => ({ repo: "sample/keel", number, at: 10 })) }));
    const ctx = makeContext(host, "board", profile);
    expect((await refreshDashboard(ctx)).complete).toBe(false);
    host.clock.t += 1000;
    const all = await refreshDashboard(ctx);
    expect(all.rows).toHaveLength(3);
    expect(all.rows.find((row) => row.number === 2)).toMatchObject({ author: "teammate", linked: true });
    expect(all.rows.find((row) => row.number === 3)).toMatchObject({ state: "UNKNOWN", activity: "stale" });
    expect(all.error).toBeTruthy();
  });

  it("keeps open and history scans isolated and returns merged PRs in history", async () => {
    const host = fakeHost({ node: async (_method, raw: any) => ({ ok: true, result: { owner: "demo", rows: raw.scope === "all" ? [makePull(1), makePull(2, { state: "MERGED" })] : [makePull(1)], total: raw.scope === "all" ? 2 : 1, nextCursor: null } }) });
    const ctx = makeContext(host, "board", profile);
    const open = await refreshDashboard(ctx);
    const history = await refreshDashboard(ctx, { scope: "all" });
    expect(open.rows).toHaveLength(1);
    expect(history.rows).toHaveLength(2);
    expect(history.rows[1]?.activity).toBe("closed");
    expect(host.files.has("board/dashboard-open.json")).toBe(true);
    expect(host.files.has("board/dashboard-all.json")).toBe(true);
  });

  it("local step updates never renew the GitHub sync timestamp or issue a new API call", async () => {
    const pull = makePull(); let requests = 0;
    const host = fakeHost({ node: async () => { requests++; return { ok: true, result: { owner: "demo", rows: [pull], total: 1, nextCursor: null } }; } });
    const run = makeRun(pull, "implement", host.now()); saveRun(host, run);
    const ctx = makeContext(host, "board", profile);
    const initial = await refreshDashboard(ctx);
    host.clock.t += 10_000;
    run.progress = { nodeId: "implement", dispatchKey: run.nodes.implement!.dispatch_key!, step: 4, at: host.now() }; run.updated_at = host.now(); saveRun(host, run);
    await updateDashboardLocal(ctx, "open", pull.key);
    expect(requests).toBe(1);
    expect(initial.lastSuccessAt).toBe(initial.at);
    const packet = [...host.broadcasts].reverse().find((message: any) => message.type === "dashboard-local") as any;
    expect(packet.row.step.index).toBe(3);
    expect(packet.row.activityAt).toBe(host.now());
  });

  it("restores cache only to the requesting panel and labels it unverified", async () => {
    const source = fakeHost({ node: async () => ({ ok: true, result: { owner: "demo", rows: [makePull()], total: 1, nextCursor: null } }) });
    await refreshDashboard(makeContext(source, "board", profile));
    const restored = fakeHost();
    restored.files.set("board/dashboard-open.json", source.files.get("board/dashboard-open.json")!);
    await restoreDashboard(makeContext(restored, "restore", profile), "open", "panel-2");
    expect(restored.broadcasts.every((packet: any) => packet.target === "panel-2")).toBe(true);
    expect((restored.broadcasts.at(-1) as any).error).toContain("缓存");
  });
  it("retains a concurrent local step when the next GitHub scan finishes with older evidence", async () => {
    const pull = makePull(); let release!: () => void; let started!: () => void; let delayed = false;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    const host = fakeHost({ node: async () => {
      if (delayed) { started(); await new Promise<void>((resolve) => { release = resolve; }); }
      return { ok: true, result: { owner: "demo", rows: [pull], total: 1, nextCursor: null } };
    } });
    const ctx = makeContext(host, "board", profile);
    const run = makeRun(pull, "implement", host.now()); saveRun(host, run);
    await refreshDashboard(ctx);
    delayed = true; host.clock.t += 31_000;
    const scanning = refreshDashboard(ctx); await waiting;
    run.progress = { nodeId: "implement", dispatchKey: run.nodes.implement!.dispatch_key!, step: 4, at: host.now() };
    run.updated_at = host.now(); saveRun(host, run);
    await updateDashboardLocal(ctx, "open", pull.key);
    release(); const snapshot = await scanning;
    expect(snapshot.rows[0]?.step.index).toBe(3);
    expect(JSON.parse(host.files.get("board/dashboard-open.json")!).rows[0].step.index).toBe(3);
  });
});

describe("managed PR tracking", () => {
  it("serializes concurrent registrations and ignores global board reads", async () => {
    const host = fakeHost(); const ctx = makeContext(host, "call", profile, undefined, "lead");
    await Promise.all([trackDashboardResult(ctx, "pr_open", {}, { url: "https://github.com/sample/keel/pull/1" }), trackDashboardResult(ctx, "pr_status", {}, { pr: { repo: "other/repo", number: 1 } })]);
    await trackDashboardResult(ctx, "pr_status", { board: true }, { repo: "not/managed", number: 9 });
    const rows = JSON.parse(host.files.get("board/managed.json")!).rows;
    expect(rows).toHaveLength(2);
    expect(rows.every((row: any) => row.sessionId === "lead")).toBe(true);
    expect(rows.some((row: any) => row.repo === "other/repo")).toBe(true);
  });
});
