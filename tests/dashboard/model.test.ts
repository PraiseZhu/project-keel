import { describe, expect, it } from "vitest";
import { projectPull } from "../../src/main/dashboard/project.ts";
import { activityOf, applyDashboardMessage, emptyDashboard, filteredCards, validCard } from "../../src/panel/dashboard-model.ts";
import { cardBody, dashboardMarkup, steps } from "../../src/panel/dashboard-render.ts";
import { makePull, makeRun } from "./fixtures.ts";

const now = 1_800_000_000_000;
const card = (number = 1) => projectPull(makePull(number), { now });

describe("truthful PR projection", () => {
  it("does not invent a Keel step or a merge guarantee for an unlinked PR", () => {
    const row = projectPull(makePull(1, { checks: "SUCCESS" }), { now });
    expect(row).toMatchObject({ stage: "cloud", linked: false, status: "检查已通过", step: { index: null } });
    expect(row.detail).toContain("未关联");
    expect(row.detail).toContain("门禁");
  });
  it("keeps local combined-node steps unknown until an explicit report arrives", () => {
    const pull = makePull(); const run = makeRun(pull, "implement", now - 1000);
    const unknown = projectPull(pull, { now, run });
    expect(unknown.stage).toBe("local"); expect(unknown.step.index).toBe(null);
    run.progress = { nodeId: "implement", dispatchKey: run.nodes.implement!.dispatch_key!, step: 4, at: now - 500 };
    expect(projectPull(pull, { now, run }).step.index).toBe(3);
    run.progress.dispatchKey = "older-attempt";
    expect(projectPull(pull, { now, run }).step.index).toBe(null);
  });
  it("never renews task activity from a fresh GitHub update or accepts future activity", () => {
    const pull = makePull(1, { updatedAt: new Date(now).toISOString() });
    const run = makeRun(pull, "implement", now - 100_000);
    expect(projectPull(pull, { now, run }).activity).toBe("stale");
    run.updated_at = now + 10_000;
    expect(projectPull(pull, { now, run }).activity).toBe("stale");
  });
  it("shows an explicit human gate, not a red CI check, as requiring the user", () => {
    const pull = makePull(1, { checks: "FAILURE" });
    const run = makeRun(pull, "fix-ci", now - 1000);
    const active = projectPull(pull, { now, run });
    expect(active.activity).toBe("running"); expect(active.detail).toContain("CI 未通过");
    run.next = { kind: "decide", gate_id: "human:fix-ci", question: "授权范围需要确认", options: ["stop"] };
    expect(projectPull(pull, { now, run })).toMatchObject({ activity: "needs-human", status: "等待你的决定" });
  });
  it("does not count a finished run as automatic progress or claim the PR is mergeable", () => {
    const pull = makePull(1, { checks: "SUCCESS" });
    const run = makeRun(pull, "report-ready", now, { status: "done" });
    const row = projectPull(pull, { now, run });
    expect(row).toMatchObject({ activity: "done", status: "本轮已结束", state: "OPEN" });
    const store = emptyDashboard(); store.rows.set(row.key, row);
    expect(filteredCards(store, { repo: "all", query: "", filter: "running", stage: null }, now)).toEqual([]);
    expect(row.detail).toContain("不表示 PR 已合并");
  });
  it("requires a matching completed handoff and never fabricates Mini progress", () => {
    const pull = makePull();
    const record = { repo: pull.repo, number: pull.number, at: new Date(now).toISOString(), head_sha: pull.headSha, gate: {}, evidence: {}, status: "complete" as const };
    const handed = projectPull(pull, { now, handoff: record });
    expect(handed).toMatchObject({ stage: "handoff", step: { index: 0, labels: ["已交接", "mini 盯梢", "可合并"] } });
    expect(handed.detail).toContain("内部步骤未接入");
    expect(projectPull(pull, { now, handoff: { ...record, status: "pending" } }).stage).toBe("cloud");
    expect(projectPull(pull, { now, handoff: { ...record, repo: "other/repo" } }).stage).toBe("cloud");
  });
  it("does not show old-head activity as current or keep merged PRs running", () => {
    const pull = makePull(); const run = makeRun(pull, "implement", now);
    expect(projectPull({ ...pull, headSha: "b".repeat(40) }, { now, run })).toMatchObject({ activity: "stale", step: { index: null } });
    expect(projectPull({ ...pull, state: "MERGED" }, { now, run })).toMatchObject({ activity: "closed", status: "已合并" });
  });
});

describe("dashboard packet reducer", () => {
  const packet = (type: string, extra: Record<string, unknown> = {}) => ({ type, scope: "open", owner: "demo", epoch: "brain-1", generation: 1, ...extra });
  it("does not lose unvisited rows on a partial refresh and prunes only at completion", () => {
    const store = emptyDashboard();
    applyDashboardMessage(store, packet("dashboard-begin"), "panel");
    applyDashboardMessage(store, packet("dashboard-page", { rows: [card(1), card(2)] }), "panel");
    applyDashboardMessage(store, packet("dashboard-end", { complete: true, total: 2 }), "panel");
    applyDashboardMessage(store, packet("dashboard-begin", { generation: 2, keepExisting: true }), "panel");
    applyDashboardMessage(store, packet("dashboard-page", { generation: 2, rows: [card(1)] }), "panel");
    applyDashboardMessage(store, packet("dashboard-end", { generation: 2, complete: false, total: 2 }), "panel");
    expect(store.rows.size).toBe(2);
    applyDashboardMessage(store, packet("dashboard-end", { generation: 2, complete: true, total: 1 }), "panel");
    expect(store.rows.size).toBe(1); expect(store.total).toBe(1);
  });
  it("rejects late pages, wrong panel/owner/scope, and retired brain epochs", () => {
    const store = emptyDashboard();
    applyDashboardMessage(store, packet("dashboard-begin"), "panel");
    expect(applyDashboardMessage(store, packet("dashboard-page", { target: "other", rows: [card()] }), "panel")).toBe(false);
    expect(applyDashboardMessage(store, packet("dashboard-page", { scope: "all", rows: [card()] }), "panel")).toBe(false);
    expect(applyDashboardMessage(store, packet("dashboard-page", { owner: "other", rows: [card()] }), "panel")).toBe(false);
    applyDashboardMessage(store, packet("dashboard-begin", { epoch: "brain-2", generation: 0 }), "panel");
    expect(applyDashboardMessage(store, packet("dashboard-begin", { generation: 9 }), "panel")).toBe(false);
    expect(store.epoch).toBe("brain-2");
  });
  it("does not mix an old owner's rows into a new owner", () => {
    const store = emptyDashboard();
    applyDashboardMessage(store, packet("dashboard-begin"), "panel");
    applyDashboardMessage(store, packet("dashboard-page", { rows: [card()] }), "panel");
    applyDashboardMessage(store, packet("dashboard-begin", { owner: "new-owner", generation: 2, keepExisting: true }), "panel");
    expect(store.rows.size).toBe(0);
  });
  it("never treats a rejected page as a complete empty result", () => {
    const store = emptyDashboard();
    applyDashboardMessage(store, packet("dashboard-begin"), "panel");
    applyDashboardMessage(store, packet("dashboard-page", { rows: [card()] }), "panel");
    applyDashboardMessage(store, packet("dashboard-end", { complete: true, total: 1, connection: "live" }), "panel");
    applyDashboardMessage(store, packet("dashboard-begin", { generation: 2, keepExisting: true }), "panel");
    applyDashboardMessage(store, packet("dashboard-page", { generation: 2, rows: [{ key: "broken" }] }), "panel");
    applyDashboardMessage(store, packet("dashboard-end", { generation: 2, complete: true, total: 1, connection: "live" }), "panel");
    expect(store.rows.size).toBe(1); expect(store.complete).toBe(false); expect(store.connection).toBe("offline");
    expect(store.error).toContain("不完整数据");
  });
  it("keeps fresher workflow events but does not let them override merge or failure facts", () => {
    const store = emptyDashboard(); const pull = makePull(); const run = makeRun(pull, "implement", now);
    const current = projectPull(pull, { now, run });
    applyDashboardMessage(store, packet("dashboard-begin"), "panel");
    applyDashboardMessage(store, packet("dashboard-page", { rows: [current] }), "panel");
    const old = { ...current, workflowAt: now - 100_000, activityAt: now - 100_000, activity: "stale" as const };
    applyDashboardMessage(store, packet("dashboard-page", { rows: [old] }), "panel");
    expect(store.rows.get(pull.key)?.activity).toBe("running");
    applyDashboardMessage(store, packet("dashboard-page", { rows: [{ ...old, state: "MERGED", activity: "closed" }] }), "panel");
    expect(store.rows.get(pull.key)?.activity).toBe("closed");
  });
  it("filters across repositories without confusing equal PR numbers", () => {
    const store = emptyDashboard();
    const first = card(42), second = projectPull(makePull(42, { repo: "another/repo" }), { now });
    store.rows.set(first.key, first); store.rows.set(second.key, second);
    expect(filteredCards(store, { repo: "all", query: "#42", filter: "all", stage: null }, now)).toHaveLength(2);
    expect(filteredCards(store, { repo: "another/repo", query: "", filter: "all", stage: null }, now)).toHaveLength(1);
    expect(activityOf({ ...first, activity: "running", activityAt: now - 100_000 }, now)).toBe("stale");
  });
});

describe("dashboard markup", () => {
  it("escapes untrusted titles and detail text and uses canonical GitHub URLs", () => {
    const row = card(); row.sessionLabel = '<img src=x onerror="alert(1)">'; row.detail = '<script>alert(1)</script>'; row.url = "javascript:alert(1)";
    const html = cardBody(row, now);
    expect(html).not.toContain("<img"); expect(html).not.toContain("<script"); expect(html).not.toContain("javascript:");
    expect(html).toContain("&lt;img"); expect(html).toContain("https://github.com/sample/keel/pull/1");
    expect(validCard({ ...row, ci: { total: 1, passed: '<svg onload=alert(1)>', failed: 0, pending: 0, complete: true } })).toBe(false);
  });
  it("keeps the step number on the left, has no thumb, and marks only true linear progress", () => {
    const row = card(); row.step = { labels: ["一", "二", "三"], index: 1, linear: true };
    const html = steps(row, "running");
    expect(html.indexOf("step-no")).toBeLessThan(html.indexOf("step-line"));
    expect(html.match(/class="sl cur"/g)).toHaveLength(1);
    expect(html).toContain('class="sl done"'); expect(html).not.toMatch(/thumb|step-dot/);
    expect(steps({ ...row, step: { ...row.step, linear: false } }, "waiting")).not.toContain("sl done");
    expect(steps(row, "stale")).toContain("步骤 ?");
  });
  it("replaces the old PR/fanout/ledger tabs and manual schedule controls", () => {
    const html = dashboardMarkup();
    expect(html).not.toMatch(/data-tab|fanout-list|ledger-list|id="schedule"/);
    expect(html).toContain("包含已合并 / 关闭"); expect(html).toContain("board-header-track");
  });
});
