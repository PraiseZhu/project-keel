import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../../src/node/rpc.ts";
import { refreshDashboard, updateDashboardLocal } from "../../src/main/dashboard/service.ts";
import { makeContext } from "../../src/main/context.ts";
import { fakeHost } from "../helpers/fakeHost.ts";
import { makePull } from "./fixtures.ts";
import { projectVigil, vigilByPull } from "../../src/main/dashboard/vigil.ts";
import { cardBody, vigilDetails } from "../../src/panel/dashboard-render.ts";
import { validCard } from "../../src/panel/dashboard-model.ts";

const roots: string[] = [];
const now = Date.UTC(2026, 9, 21, 8);
const sha = "a".repeat(40);
const id = "repair-20261021-080000";
const identity = { dispatchId: id, repo: "sample/keel", number: 42, nodeId: "PR_sample", sessionId: "sample-session-42" };

async function json(root: string, path: string, value: unknown) {
  const file = join(root, path);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, JSON.stringify(value));
  return file;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "keel-vigil-"));
  roots.push(root);
  await json(root, "config/profile.json", { targetRepo: identity.repo });
  await json(root, "state/prs/PR_sample.json", { nodeId: identity.nodeId, number: 42, sessionId: identity.sessionId, headRefOid: sha,
    activeTask: { ...identity, head: sha, status: "blocked", at: new Date(now - 600_000).toISOString(), reason: "old failure" } });
  await json(root, `state/tasks/${id}.json`, { ...identity, headRefOid: sha, createdAt: new Date(now - 600_000).toISOString(), keelRunId: "run-20261021080000-abcdef" });
  await json(root, `state/activity/${id}.json`, { dispatchId: id, op: "validate", at: new Date(now - 1000).toISOString() });
  return root;
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("Vigil read-only progress", () => {
  it("reads an existing task and a newer validate heartbeat without modifying watcher files", async () => {
    const root = await fixture();
    const path = join(root, `state/prs/${identity.nodeId}.json`);
    const before = await readFile(path, "utf8");
    const result = await dispatch("vigil/progress", { profile: { lanes: [], routingPath: null, boardRepos: [], plansDir: null, vigilHomes: [root] } });
    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({ warnings: [], rows: [{ ...identity, sourceHead: sha, activity: { op: "validate" }, paths: { task: join(await realpath(root), `state/tasks/${id}.json`) } }] });
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("does not link a task whose PR identity differs from the watcher binding", async () => {
    const root = await fixture();
    await json(root, `state/tasks/${id}.json`, { ...identity, number: 99, headRefOid: sha });
    const response = await dispatch("vigil/progress", { profile: { vigilHomes: [root] } as never });
    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({ rows: [], warnings: [expect.any(String)] });
  });

  it("reports an unreadable configured source instead of silently claiming no tasks", async () => {
    const root = await fixture();
    const response = await dispatch("vigil/progress", { profile: { vigilHomes: [join(root, "missing")] } as never });
    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({ rows: [], warnings: [expect.any(String)] });
  });

  it("does not let method arguments add an unconfigured source", async () => {
    const root = await fixture();
    const response = await dispatch("vigil/progress", { homes: [root] });
    expect(response).toEqual({ result: { rows: [], warnings: [] } });
  });

  it.each(["../outside", "task/elsewhere", "task\\elsewhere"])("rejects unsafe dispatch path %s", async (dispatchId) => {
    const root = await fixture();
    await json(root, "state/prs/PR_sample.json", { nodeId: identity.nodeId, number: 42, sessionId: identity.sessionId, activeTask: { dispatchId } });
    const response = await dispatch("vigil/progress", { profile: { vigilHomes: [root] } as never });
    expect(response.result).toMatchObject({ rows: [], warnings: [expect.any(String)] });
  });

  it("accepts a validation receipt whose stored path is a symlink alias of the home", async () => {
    const root = await fixture();
    const alias = `${root}-alias`;
    await symlink(root, alias);
    try {
      const receipt = { ...identity, schemaVersion: 2, kind: "mivo-repair-validation", head: sha, status: "pass", exitCode: 0, finishedAt: new Date(now).toISOString() };
      const receiptPath = await json(alias, `state/validations/${id}/${sha}-receipt.json`, receipt);
      await json(root, `state/validations/${id}/${sha}.json`, { head: sha, status: "pass", receiptPath, receiptSha256: createHash("sha256").update(JSON.stringify(receipt)).digest("hex") });
      const response = await dispatch("vigil/progress", { profile: { vigilHomes: [root] } as never });
      expect(response.result).toMatchObject({ rows: [{ validation: { status: "pass", head: sha, exitCode: 0 }, paths: { validation: receiptPath } }], warnings: [] });
    } finally { await rm(alias, { force: true }); }
  });

  it.each(["mivo-repair-validation", "cindy-repair-validation"])("accepts a %s receipt with matching identity and hash", async (kind) => {
    const root = await fixture();
    const receipt = { ...identity, schemaVersion: 2, kind, head: sha, status: "pass", exitCode: 0, finishedAt: new Date(now).toISOString() };
    const receiptPath = await json(root, `state/validations/${id}/${sha}-receipt.json`, receipt);
    await json(root, `state/validations/${id}/${sha}.json`, { head: sha, status: "pass", receiptPath, receiptSha256: createHash("sha256").update(JSON.stringify(receipt)).digest("hex") });
    const response = await dispatch("vigil/progress", { profile: { vigilHomes: [root] } as never });
    expect(response.result).toMatchObject({ rows: [{ validation: { status: "pass", head: sha, exitCode: 0 }, paths: { validation: receiptPath } }], warnings: [] });
  });

  it.each(["mivo-repair-result", "cindy-repair-result"])("accepts a %s terminal result with matching identity", async (kind) => {
    const root = await fixture();
    await json(root, `state/results/${id}.json`, { ...identity, schemaVersion: 2, kind, status: "complete",
      head: sha, sourceHead: sha, observedAt: new Date(now).toISOString() });
    const response = await dispatch("vigil/progress", { profile: { vigilHomes: [root] } as never });
    expect(response.result).toMatchObject({ rows: [{ result: { status: "complete", head: sha } }], warnings: [] });
  });

  it("rejects an unknown validation kind even when the hash and identity match", async () => {
    const root = await fixture();
    const receipt = { ...identity, schemaVersion: 2, kind: "other-repair-validation", head: sha, status: "pass", exitCode: 0, finishedAt: new Date(now).toISOString() };
    const receiptPath = await json(root, `state/validations/${id}/${sha}-receipt.json`, receipt);
    await json(root, `state/validations/${id}/${sha}.json`, { head: sha, status: "pass", receiptPath, receiptSha256: createHash("sha256").update(JSON.stringify(receipt)).digest("hex") });
    const response = await dispatch("vigil/progress", { profile: { vigilHomes: [root] } as never });
    expect(response.result).toMatchObject({ rows: [], warnings: [expect.any(String)] });
  });

  it("verifies the actual validation receipt hash and identity", async () => {
    const root = await fixture();
    const receipt = { ...identity, schemaVersion: 2, kind: "mivo-repair-validation", head: sha, status: "pass", exitCode: 0, finishedAt: new Date(now).toISOString() };
    const receiptPath = await json(root, `state/validations/${id}/${sha}-receipt.json`, receipt);
    const pointerPath = `state/validations/${id}/${sha}.json`;
    const pointer = { head: sha, status: "pass", receiptPath, receiptSha256: createHash("sha256").update(JSON.stringify(receipt)).digest("hex") };
    await json(root, pointerPath, pointer);
    const request = { profile: { vigilHomes: [root] } as never };
    const response = await dispatch("vigil/progress", request);
    expect(response.result).toMatchObject({ rows: [{ validation: { status: "pass", head: sha, exitCode: 0 }, paths: { validation: receiptPath } }], warnings: [] });
    await json(root, pointerPath, { ...pointer, receiptSha256: "0".repeat(64) });
    const badHash = await dispatch("vigil/progress", request);
    expect(badHash.result).toMatchObject({ rows: [], warnings: [expect.any(String)] });
  });

  it("isolates a bad home while retaining tasks from a readable home", async () => {
    const root = await fixture();
    const response = await dispatch("vigil/progress", { profile: { vigilHomes: [join(root, "missing"), root] } as never });
    expect(response.result).toMatchObject({ rows: [{ number: 42 }], warnings: [expect.any(String)] });
  });

  it("reports an invalid configuration without attempting to scan a directory", async () => {
    const response = await dispatch("vigil/progress", { profile: { vigilHomes: "not-an-array" } as never });
    expect(response.error?.message).toContain("VIGIL_CONFIG_INVALID");
  });

  it("marks a same-HEAD task from an older Ready generation as superseded", async () => {
    const root = await fixture();
    await json(root, "state/prs/PR_sample.json", { nodeId: identity.nodeId, number: 42, sessionId: identity.sessionId, handoff: { id: "new-ready-generation" },
      activeTask: { ...identity, head: sha, status: "running", at: new Date(now).toISOString() } });
    await json(root, `state/tasks/${id}.json`, { ...identity, headRefOid: sha, handoff: { id: "old-ready-generation" } });
    const response = await dispatch("vigil/progress", { profile: { vigilHomes: [root] } as never });
    expect(response.result).toMatchObject({ rows: [{ superseded: true }], warnings: [] });
  });

  it.each([{ sessionId: "another-session" }, { number: 99 }, { sourceHead: "b".repeat(40) }])("rejects a terminal result with a different task binding: %j", async (override) => {
    const root = await fixture();
    await json(root, `state/results/${id}.json`, { ...identity, schemaVersion: 2, kind: "mivo-repair-result", status: "complete",
      head: sha, sourceHead: sha, observedAt: new Date(now).toISOString(), ...override });
    const response = await dispatch("vigil/progress", { profile: { vigilHomes: [root] } as never });
    expect(response.result).toMatchObject({ rows: [], warnings: [expect.any(String)] });
  });
});

describe("Vigil tasks on the Keel dashboard", () => {
  function setup(overrides: Record<string, unknown> = {}) {
    const pull = makePull(42);
    const progress = { ...identity, sourceHead: sha, taskStatus: "blocked", taskAt: now - 600_000,
      activity: { op: "validate", at: now - 1000 }, paths: { task: "/runtime/state/tasks/task.json", activity: "/runtime/state/activity/task.json" }, ...overrides };
    const host = fakeHost({ node: async (method) => method === "vigil/progress"
      ? { ok: true, result: { rows: [progress], warnings: [] } }
      : { ok: true, result: { owner: "demo", rows: [pull], total: 1, nextCursor: null } } });
    host.clock.t = now;
    const ctx = makeContext(host, "board", { lanes: [], routingPath: null, boardRepos: [], plansDir: null, vigilHomes: ["/runtime"] } as never);
    return { host, ctx, pull, progress };
  }

  it("shows an existing Vigil repair session validating, without starting a Keel run", async () => {
    const { host, ctx } = setup();
    const board = await refreshDashboard(ctx);
    expect(board.rows[0]).toMatchObject({ linked: true, sessionId: identity.sessionId, activity: "running", status: "正在运行本地预检", stage: "local" });
    expect(board.rows[0]?.detail).not.toContain("未关联");
    expect(host.nodeCalls.map((call) => call.method)).toEqual(["vigil/progress", "pr/board"]);
    expect([...host.files.keys()].some((key) => key.includes("graph-state"))).toBe(false);
  });

  it("does not turn an expired heartbeat into a running task", async () => {
    const { ctx } = setup({ activity: { op: "validate", at: now - 600_000 } });
    const board = await refreshDashboard(ctx);
    expect(board.rows[0]).toMatchObject({ activity: "stale", status: "Vigil 活动待确认" });
  });

  it("shows a newer blocked result rather than an older validate heartbeat", async () => {
    const { ctx } = setup({ result: { status: "blocked", head: sha, at: now, reason: "test command timed out" } });
    const board = await refreshDashboard(ctx);
    expect(board.rows[0]).toMatchObject({ activity: "needs-human", status: "修复受阻" });
    expect(board.rows[0]?.detail).toContain("test command timed out");
  });

  it("keeps an old task linked but does not apply its progress to a new remote HEAD", async () => {
    const { ctx } = setup({ sourceHead: "b".repeat(40) });
    const board = await refreshDashboard(ctx);
    expect(board.rows[0]).toMatchObject({ linked: true, activity: "stale", status: "Vigil 任务已过期" });
    expect(board.rows[0]?.step.index).toBeNull();
  });

  it("shows ledger evidence and the existing session and receipt locations in the card detail", async () => {
    const { host, ctx } = setup({ runId: "run-20261021080000-abcdef" });
    host.files.set("runs/run-20261021080000-abcdef/decisions.jsonl", JSON.stringify({ kind: "evidence", at: new Date(now).toISOString(), summary: "Independent review completed: 37 tests passed" }));
    const board = await refreshDashboard(ctx);
    const row = board.rows[0]!;
    expect(vigilDetails(row)).toContain("Independent review completed");
    expect(vigilDetails(row)).toContain("/runtime/state/tasks/task.json");
    expect(cardBody(row, now)).toContain("Vigil 任务记录");
  });

  it("does not choose an arbitrary task when three homes claim the same PR", () => {
    const { progress } = setup();
    const snapshot = { rows: [progress, { ...progress }, { ...progress }], warnings: [] };
    expect(vigilByPull(snapshot).size).toBe(0);
    expect(snapshot.warnings).toHaveLength(1);
  });

  it("does not treat a newer heartbeat for a different operation as proof that old validation still runs", async () => {
    const { ctx } = setup({ activity: { op: "assert-owner", at: now - 1000 } });
    expect((await refreshDashboard(ctx)).rows[0]?.activity).toBe("waiting");
  });

  it("does not claim the current working copy passed merely because a validation receipt exists", async () => {
    const { ctx } = setup({ validation: { status: "pass", head: "b".repeat(40), at: now, exitCode: 0 } });
    const row = (await refreshDashboard(ctx)).rows[0]!;
    expect(row.status).toBe("已有通过回执，推送待确认");
    expect(row.detail).toContain("bbbbbbbbbbbb");
  });

  it("rejects malformed optional progress payloads at the panel boundary", async () => {
    const { ctx } = setup();
    const row = (await refreshDashboard(ctx)).rows[0]!;
    expect(validCard(row)).toBe(true);
    expect(validCard({ ...row, vigil: { dispatchId: "bad" } })).toBe(false);
  });

  it("does not let a future timestamp keep a task or validation result looking current", async () => {
    const { ctx } = setup({ activity: { op: "validate", at: now + 60_000 }, validation: { status: "pass", head: sha, at: now + 120_000, exitCode: 0 } });
    const row = (await refreshDashboard(ctx)).rows[0]!;
    expect(row.activity).toBe("stale");
    expect(row.step.index).toBeNull();
  });

  it("retains a known session but stops displaying live progress when its source becomes unreadable", async () => {
    const { host, ctx } = setup();
    await refreshDashboard(ctx);
    host.node = async (method) => method === "vigil/progress" ? { ok: false, message: "Vigil source unavailable" }
      : { ok: true, result: { owner: "demo", rows: [makePull(42)], total: 1, nextCursor: null } };
    host.clock.t += 31_000;
    const board = await refreshDashboard(ctx);
    expect(board).toMatchObject({ connection: "partial", complete: true });
    expect(board.rows[0]).toMatchObject({ linked: true, sessionId: identity.sessionId, activity: "stale", status: "Vigil 进度暂不可读" });
    await updateDashboardLocal(ctx, "open", "sample/keel#42");
    const last = host.broadcasts.at(-1);
    expect(last).toMatchObject({ type: "dashboard-local", row: { linked: true, activity: "stale", status: "Vigil 进度暂不可读" } });
  });

  it("keeps the association for an ended PR without showing an active task", async () => {
    const { ctx, progress } = setup();
    const open = (await refreshDashboard(ctx)).rows[0]!;
    const closed = projectVigil({ ...open, vigil: undefined, state: "MERGED", stage: "cloud", activity: "closed", status: "已合并" }, progress, now);
    expect(closed).toMatchObject({ vigil: { dispatchId: id }, linked: true, activity: "closed", status: "已合并" });
  });

  it("does not display a superseded same-HEAD task as running", async () => {
    const { ctx } = setup({ superseded: true });
    expect((await refreshDashboard(ctx)).rows[0]).toMatchObject({ status: "Vigil 任务已过期", activity: "stale" });
  });

  it("shows an explicitly approved validation exception separately from a failed test", async () => {
    const { ctx } = setup({ validation: { status: "approved-exception", head: sha, at: now, exitCode: null } });
    expect((await refreshDashboard(ctx)).rows[0]).toMatchObject({ status: "已有验证例外，推送待确认", activity: "waiting" });
  });

  it.each(["complete", "waiting-ci"])("shows a terminal %s result as a result, not a running local test", async (status) => {
    const { ctx } = setup({ result: { status, head: sha, at: now } });
    const row = (await refreshDashboard(ctx)).rows[0]!;
    expect(row.stage).toBe("cloud");
    expect(row.activity).toBe(status === "complete" ? "done" : "waiting");
  });

  it("does not replace a newer Keel run with an older Vigil task", async () => {
    const { ctx, progress } = setup();
    const row = (await refreshDashboard(ctx)).rows[0]!;
    const current = { ...row, runId: "newer-keel-run", workflowAt: now + 1000, status: "current Keel task" };
    expect(projectVigil(current, progress, now + 2000)).toBe(current);
  });
});
