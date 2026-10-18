import { describe, expect, it } from "vitest";
import { makeContext } from "../../src/main/context.ts";
import { currentDashboardHandoff, prepareDashboardHandoffContext } from "../../src/main/dashboard/handoff.ts";
import { projectPull } from "../../src/main/dashboard/project.ts";
import { recordDashboardProgress } from "../../src/main/dashboard/progress.ts";
import { boardEvidence, managedPulls, trackDashboardResult } from "../../src/main/dashboard/registry.ts";
import { advance, createRun } from "../../src/main/graph/interpreter.ts";
import type { GraphRunState } from "../../src/main/graph/state.ts";
import { writeHandoff, type HandoffRecord } from "../../src/main/handoff.ts";
import { driveGraphEvent, keelWait } from "../../src/main/tools/keel.ts";
import { emptyDashboard, filteredCards } from "../../src/panel/dashboard-model.ts";
import type { RemotePull } from "../../src/shared/dashboard.ts";
import { fakeHost, type FakeHost } from "../helpers/fakeHost.ts";
import { makePull, makeRun, saveRun } from "./fixtures.ts";

const now = 1_800_000_000_000;
const profile = { lanes: [], boardRepos: [], routingPath: null, plansDir: null };
const context = (host: FakeHost) => makeContext(host, "projection-regression", profile, undefined, "lead");

function localRun(host: FakeHost, pull: RemotePull, runId: string, at: number): GraphRunState {
  const run = makeRun(pull, "implement", at, { run_id: runId, goal: runId });
  Object.assign(run.nodes.implement!, {
    dispatch_key: `${runId}:implement:1`, worker_label: `${runId}-worker`,
    worker_id: `${runId}-worker`, worker_session_id: `${runId}-session`,
  });
  run.next = { kind: "wait", call: { tool: "keel_wait", args: { run_id: runId } } };
  saveRun(host, run);
  return run;
}

function storedRun(host: FakeHost, runId: string): GraphRunState {
  return JSON.parse(host.files.get(`runs/${runId}/graph-state.json`)!);
}

function handoffRecord(pull: RemotePull): HandoffRecord {
  return {
    repo: pull.repo, number: pull.number, at: new Date(now - 600_000).toISOString(), head_sha: pull.headSha,
    status: "complete", gate: {}, evidence: {}, watcher_receipt: {
      version: 1, id: "receipt-old", repo: pull.repo, number: pull.number, nodeId: "PR_SYNTHETIC",
      head: pull.headSha, releaseEpoch: "ready:1", author: "synthetic-author",
    },
  };
}

const helperLane = (repo: string) => ({ repo, preset: "gated-handoff" as const, handoffHelperPath: "/synthetic/helper.mjs" });

describe("dashboard current handoff regressions", () => {
  it.each([
    { name: "Draft on the same head", isDraft: true, headSha: "a".repeat(40), epoch: "draft:2" },
    { name: "new Ready generation on the same head", isDraft: false, headSha: "a".repeat(40), epoch: "ready:3" },
    { name: "reclaimed generation on a new head", isDraft: true, headSha: "b".repeat(40), epoch: "draft:4" },
  ])("does not assign $name to mini based on a stale local receipt", async (scenario) => {
    const original = makePull();
    const pull = { ...original, isDraft: scenario.isDraft, headSha: scenario.headSha };
    const host = fakeHost({ kv: { lanes: [helperLane(pull.repo)], manual: { malformed: true } }, node: (method, params) => {
      expect(method).toBe("pr/handoff-state");
      expect(params.profile.lanes).toEqual([helperLane(pull.repo)]);
      return { ok: true, result: {
        status: pull.isDraft ? "author-owned" : "ready-unclaimed", receipt: null, authorAuthorized: true,
        pr: { repo: pull.repo, number: pull.number, headRefOid: pull.headSha, state: "OPEN", isDraft: pull.isDraft, releaseEpoch: scenario.epoch },
      } };
    } });
    host.clock.t = now;
    await writeHandoff(host, handoffRecord(original));
    const run = localRun(host, pull, "current-owner", now);
    const handoff = await currentDashboardHandoff(context(host), pull);
    expect(handoff).toBeNull();
    expect(projectPull(pull, { now, run, handoff })).toMatchObject({ stage: "local", activity: "running" });
    expect(host.kvReads).toBe(1);
    expect(host.nodeCalls.map((call) => call.method)).toEqual(["pr/handoff-state"]);
  });

  it("retains authoritative ownership when mini updates HEAD within the same generation", async () => {
    const original = makePull(); const record = handoffRecord(original);
    const pull = { ...original, headSha: "c".repeat(40) };
    const host = fakeHost({ node: () => ({ ok: true, result: {
      status: "handed-off", receipt: record.watcher_receipt,
      pr: { headRefOid: pull.headSha, state: "OPEN", isDraft: false },
    } }) });
    host.clock.t = now;
    const ctx = makeContext(host, "same-generation", { ...profile, lanes: [helperLane(pull.repo)] });
    const handoff = await currentDashboardHandoff(ctx, pull);
    expect(handoff?.head_sha).toBe(original.headSha);
    expect(projectPull(pull, { now, handoff })).toMatchObject({ stage: "handoff", activity: "handed-off", step: { index: 0 } });
  });

  it("reads only lanes once per prepared batch and never requests full PR snapshots for helper lanes", async () => {
    const pulls = [makePull(1), makePull(2), makePull(3)];
    const host = fakeHost({ kv: { lanes: [helperLane(pulls[0]!.repo)], manual: "not-a-manual" }, node: () => ({
      ok: true, result: { status: "ready-unclaimed", receipt: null, pr: { headRefOid: pulls[0]!.headSha, state: "OPEN", isDraft: false } },
    }) });
    const prepared = await prepareDashboardHandoffContext(context(host));
    await Promise.all(pulls.map((pull) => currentDashboardHandoff(prepared, pull)));
    expect(host.kvReads).toBe(1);
    expect(host.nodeCalls.map((call) => call.method)).toEqual(pulls.map(() => "pr/handoff-state"));
    await prepareDashboardHandoffContext(context(host));
    expect(host.kvReads).toBe(2);
  });

  it("respects an explicit lanes override and existing complete-record rules when no helper is configured", async () => {
    const original = makePull(); const pull = { ...original, headSha: "d".repeat(40) };
    const host = fakeHost({ kv: { lanes: [], manual: "broken" } });
    await writeHandoff(host, handoffRecord(original));
    const ctx = makeContext(host, "local-lane", { ...profile, lanes: [helperLane(pull.repo)] });
    const handoff = await currentDashboardHandoff(ctx, pull);
    expect(handoff?.status).toBe("complete");
    expect(projectPull(pull, { now, handoff }).activity).toBe("handed-off");
    expect(host.nodeCalls).toEqual([]);
  });

  it.each([
    { result: { ok: true, result: null }, code: "HANDOFF_HELPER_INVALID" },
    { result: { ok: false, message: "HANDOFF_HELPER_FAILED: unavailable" }, code: "HANDOFF_HELPER_FAILED" },
    { result: { ok: true, result: { status: "ready-unclaimed", receipt: null, pr: { headRefOid: "b".repeat(40), state: "OPEN", isDraft: false } } }, code: "HEAD_MOVED" },
  ])("surfaces $code rather than trusting an obsolete local handoff", async ({ result, code }) => {
    const pull = makePull();
    const host = fakeHost({ kv: { lanes: [helperLane(pull.repo)] }, node: () => result });
    await writeHandoff(host, handoffRecord(pull));
    await expect(currentDashboardHandoff(context(host), pull)).rejects.toMatchObject({ code });
  });

  it("distinguishes unavailable or invalid lane configuration", async () => {
    const host = fakeHost({ kv: { lanes: "not-an-array" } });
    await expect(prepareDashboardHandoffContext(context(host))).rejects.toMatchObject({ code: "LANE_CONFIG_INVALID" });
    host.kvGet = async () => { throw new Error("offline"); };
    await expect(prepareDashboardHandoffContext(context(host))).rejects.toMatchObject({ code: "KV_READ_FAILED" });
  });

  it("fails closed on unknown PR state before making an ownership claim", async () => {
    const host = fakeHost(); const pull = makePull(1, { state: "UNKNOWN" });
    await writeHandoff(host, handoffRecord(pull));
    await expect(currentDashboardHandoff(context(host), pull)).rejects.toMatchObject({ code: "BOARD_HANDOFF_UNAVAILABLE" });
    expect(host.kvReads).toBe(0); expect(host.nodeCalls).toEqual([]);
  });

  it("does not confuse denied or corrupt local records with absent handoffs", async () => {
    const pull = makePull(); const host = fakeHost();
    const originalFs = host.fs;
    host.fs = async (request) => request.path?.startsWith("handoff/") ? { ok: false, message: "EACCES" } : originalFs(request);
    await expect(currentDashboardHandoff(context(host), pull)).rejects.toMatchObject({ code: "BOARD_HANDOFF_UNAVAILABLE" });
    host.fs = originalFs;
    host.files.set("handoff/sample__keel__1.json", "{");
    await expect(currentDashboardHandoff(context(host), pull)).rejects.toMatchObject({ code: "BOARD_HANDOFF_INVALID" });
  });

  it("reconciles a successful pending Ready transition without a full snapshot", async () => {
    const pull = makePull(); const host = fakeHost(); host.clock.t = now;
    await writeHandoff(host, { ...handoffRecord(pull), status: "pending", was_draft: true });
    expect(await currentDashboardHandoff(context(host), { ...pull, isDraft: true })).toBeNull();
    const complete = await currentDashboardHandoff(context(host), pull);
    expect(complete?.status).toBe("complete");
    expect(host.nodeCalls).toEqual([]);
    expect(JSON.parse(host.files.get("handoff/sample__keel__1.json")!).status).toBe("complete");
  });

  it.each([false, true])("uses the detail gate for a pending non-Draft handoff (gate ok=%s)", async (ok) => {
    const pull = makePull();
    const host = fakeHost({ node: (method) => {
      expect(method).toBe("pr/snapshot");
      return { ok: true, result: { pr: pull, decision: { kind: "ready" }, gate: { applies: true, ok } } };
    } });
    await writeHandoff(host, { ...handoffRecord(pull), status: "pending", was_draft: false });
    const handoff = await currentDashboardHandoff(context(host), pull);
    expect(Boolean(handoff)).toBe(ok);
    expect(host.nodeCalls).toHaveLength(1);
  });
});

describe("dashboard activity evidence regressions", () => {
  it("does not turn an unobserved keel_wait into worker activity", async () => {
    const host = fakeHost(); host.clock.t = now;
    const pull = makePull();
    const run = localRun(host, pull, "clock-without-heartbeat", now - 120_000);
    expect(projectPull(pull, { now, run }).activity).toBe("stale");
    await keelWait(context(host), { run_id: run.run_id, max_minutes: 1 });
    const after = storedRun(host, run.run_id);
    expect(after.updated_at).toBe(now);
    expect(after.nodes.implement!.dispatch_state_at).toBe(now - 120_000);
    expect(projectPull(pull, { now, run: after })).toMatchObject({ activity: "stale", activityAt: now - 120_000, workflowAt: now });
    expect(host.nodeCalls).toEqual([]); expect(host.fetches).toEqual([]);
  });

  it("retains fresh dispatch reconciliation when the latest step report is older", async () => {
    const host = fakeHost(); host.clock.t = now - 120_000;
    const pull = makePull();
    const run = localRun(host, pull, "observed-worker", host.now());
    await recordDashboardProgress(context(host), { run_id: run.run_id, dispatch_key: run.nodes.implement!.dispatch_key, step: 4 });
    host.clock.t = now;
    const observed = await advance(host, run.run_id, {
      type: "report", phase: "reconcile", dispatch_key: run.nodes.implement!.dispatch_key!,
      queries_result: { list_workers: { ok: true, complete: true, workers: [{
        label: run.nodes.implement!.worker_label!, worker_id: run.nodes.implement!.worker_id,
        worker_session_id: run.nodes.implement!.worker_session_id, status: "running",
      }] } },
    });
    expect(observed.state.nodes.implement!.dispatch_state_at).toBe(now);
    expect(projectPull(pull, { now, run: observed.state })).toMatchObject({ activity: "running", activityAt: now, step: { index: 3 } });
  });

  it("uses a fresh current-attempt progress report without accepting future or old-attempt reports", () => {
    const pull = makePull(); const run = makeRun(pull, "implement", now - 120_000);
    run.progress = { nodeId: "implement", dispatchKey: run.nodes.implement!.dispatch_key!, step: 4, at: now };
    expect(projectPull(pull, { now, run })).toMatchObject({ activity: "running", activityAt: now, step: { index: 3 } });
    run.progress.at = now + 1;
    expect(projectPull(pull, { now, run })).toMatchObject({ activity: "stale", activityAt: now - 120_000, step: { index: null } });
    run.progress.at = now; run.progress.dispatchKey = "previous-attempt";
    expect(projectPull(pull, { now, run })).toMatchObject({ activity: "stale", activityAt: now - 120_000, step: { index: null } });
  });

  it("keeps workflow ordering separate from activity and rejects invalid ordering timestamps", () => {
    const pull = makePull(); const run = makeRun(pull, "implement", now - 120_000, { status: "done", updated_at: now });
    expect(projectPull(pull, { now, run })).toMatchObject({ activity: "done", workflowAt: now, activityAt: now - 120_000 });
    run.updated_at = Number.NaN;
    expect(projectPull(pull, { now, run })).not.toHaveProperty("workflowAt");
    expect(projectPull(pull, { now })).not.toHaveProperty("workflowAt");
  });
});

describe("dashboard lead gates and pending pushes", () => {
  it("projects an actual g-accept Agent decision as waiting, not a human authorization", async () => {
    const host = fakeHost(); host.clock.t = now;
    const pull = makePull(1, { checks: "SUCCESS" });
    await createRun(host, { run_id: "lead-decision", spec_id: "feature", profile_id: "sol", lead_harness: "codex",
      task_type: "feature", entry: "g-accept", goal: "Review acceptance", pr_binding: {
        repo: pull.repo, number: pull.number, head_sha: pull.headSha,
      }, sol_session_id: "lead" });
    const result = await driveGraphEvent(context(host), "lead-decision", { type: "tick" });
    expect(result.state.status).toBe("await_sol"); expect(result.state.human_inputs).toBe(0);
    expect(projectPull(pull, { now, run: result.state })).toMatchObject({ activity: "waiting", status: "等待主控裁决" });
    result.state.next = { kind: "decide", gate_id: "human:fix-ci", question: "Confirm scope", options: ["stop"] };
    expect(projectPull(pull, { now, run: result.state })).toMatchObject({ activity: "needs-human", status: "等待你的决定" });
  });

  it("keeps an actual pr_open wait on the author side even when the previous head has green CI", async () => {
    const host = fakeHost(); host.clock.t = now;
    const pull = makePull(1, { checks: "SUCCESS" });
    await createRun(host, { run_id: "pending-push", spec_id: "feature", profile_id: "sol", lead_harness: "codex",
      task_type: "feature", entry: "open-pr", goal: "Push new changes", worktree: "/synthetic/repo",
      pr_binding: { repo: pull.repo, number: pull.number, head_sha: pull.headSha }, sol_session_id: "lead" });
    const result = await advance(host, "pending-push", { type: "tick" });
    expect(result.next).toMatchObject({ kind: "wait", call: { tool: "pr_open" } });
    expect(projectPull(pull, { now, run: result.state })).toMatchObject({ stage: "local", activity: "waiting", status: "整理提交并推送", step: { index: null } });
  });
});

describe("dashboard current run generation", () => {
  it.each([
    { checks: "PENDING" as const, status: "等待 CI" },
    { checks: "SUCCESS" as const, status: "检查已通过" },
    { checks: "FAILURE" as const, status: "CI 未通过" },
  ])("does not count an index-only run as automatic progress when GitHub reports $checks", ({ checks, status }) => {
    const pull = makePull(1, { checks });
    const ref = { repo: pull.repo, number: pull.number, runId: "missing-run", sessionId: "linked-lead", at: now };
    const row = projectPull(pull, { now, ref });
    expect(row).toMatchObject({ activity: "unknown", status, checks, linked: true, runId: ref.runId, sessionId: ref.sessionId, step: { index: null } });
    expect(row.detail).toContain("流程待确认");
    expect(row).not.toHaveProperty("activityAt");
    const store = emptyDashboard(); store.rows.set(row.key, row);
    expect(filteredCards(store, { repo: "all", query: "", filter: "running", stage: null }, now)).toEqual([]);
    expect(filteredCards(store, { repo: "all", query: "", filter: "all", stage: null }, now)).toEqual([row]);
  });

  it.each(["CLOSED", "MERGED"] as const)("keeps GitHub's %s fact when the indexed run is unavailable", (state) => {
    const pull = makePull(1, { state });
    const ref = { repo: pull.repo, number: pull.number, runId: "missing-run", at: now };
    expect(projectPull(pull, { now, ref })).toMatchObject({ activity: "closed", state, runId: ref.runId });
  });

  it("keeps independently verified handoff ownership when the indexed run is unavailable", () => {
    const pull = makePull();
    const ref = { repo: pull.repo, number: pull.number, runId: "missing-run", at: now };
    expect(projectPull(pull, { now, ref, handoff: handoffRecord(pull) })).toMatchObject({ activity: "handed-off", stage: "handoff", runId: ref.runId });
  });

  it("does not let polling an old done run displace an explicitly associated run", async () => {
    const host = fakeHost(); const pull = makePull();
    const old = makeRun(pull, "done", now - 300_000, { run_id: "old-done", status: "done", nodes: {}, next: { kind: "done", summary: "done" } });
    saveRun(host, old);
    const active = localRun(host, pull, "active-new", now - 1_000);
    host.clock.t = now - 500;
    await trackDashboardResult(context(host), "keel_report", { run_id: active.run_id }, { run_id: active.run_id });
    host.clock.t = now;
    await keelWait(context(host), { run_id: old.run_id, max_minutes: 1 });
    await trackDashboardResult(context(host), "keel_wait", { run_id: old.run_id }, { run_id: old.run_id });
    const evidence = await boardEvidence(host);
    expect(evidence.runs.get(pull.key)?.run_id).toBe(active.run_id);
    expect(evidence.refs.get(pull.key)?.runId).toBe(active.run_id);
    expect((await managedPulls(host))[0]?.runId).toBe(active.run_id);
    expect(storedRun(host, active.run_id).status).toBe("running");
  });

  it.each(["done", "stopped"] as const)("retains the newest run's %s state instead of preferring an old running run", async (status) => {
    const host = fakeHost(); host.clock.t = now;
    const pull = makePull();
    const old = localRun(host, pull, "run-20261001000000-abcd", now);
    await trackDashboardResult(context(host), "keel_run", {}, { run_id: old.run_id });
    const latest = makeRun(pull, "report-ready", now - 10_000, { run_id: "run-20261002000000-abcd", status });
    saveRun(host, latest);
    const evidence = await boardEvidence(host);
    expect(evidence.runs.get(pull.key)?.run_id).toBe(latest.run_id);
    expect(projectPull(pull, { now, run: evidence.runs.get(pull.key) })).toMatchObject({ activity: status === "done" ? "done" : "paused" });
  });

  it("uses explicit association for same-second generations and preserves it on older polling", async () => {
    const host = fakeHost(); host.clock.t = now; const pull = makePull();
    const old = localRun(host, pull, "run-20261001000000-ffff", now);
    const latest = localRun(host, pull, "run-20261001000000-0000", now - 100);
    await trackDashboardResult(context(host), "keel_run", {}, { run_id: old.run_id });
    await trackDashboardResult(context(host), "keel_run", {}, { run_id: latest.run_id });
    await trackDashboardResult(context(host), "keel_wait", { run_id: old.run_id }, { run_id: old.run_id });
    expect((await boardEvidence(host)).runs.get(pull.key)?.run_id).toBe(latest.run_id);
  });

  it("does not substitute a same-second peer when the explicitly associated run snapshot is missing", async () => {
    const host = fakeHost(); const pull = makePull();
    localRun(host, pull, "run-20261001000000-abcd", now);
    host.files.set("board/managed.json", JSON.stringify({ version: 1, rows: [{
      repo: pull.repo, number: pull.number, runId: "run-20261001000000-1234", at: now,
    }] }));
    const evidence = await boardEvidence(host);
    expect(evidence.runs.get(pull.key)).toBeUndefined();
    expect(evidence.refs.get(pull.key)?.runId).toBe("run-20261001000000-1234");
    expect(projectPull(pull, { now, run: evidence.runs.get(pull.key), ref: evidence.refs.get(pull.key) })).toMatchObject({ activity: "unknown", runId: "run-20261001000000-1234" });
  });

  it("does not carry the old run's session into a newer generation without a known session", async () => {
    const host = fakeHost(); const pull = makePull();
    const old = localRun(host, pull, "run-20261001000000-abcd", now);
    await trackDashboardResult(context(host), "keel_run", {}, { run_id: old.run_id });
    const latest = makeRun(pull, "done", now - 100, { run_id: "run-20261002000000-abcd", status: "done", sol_session_id: undefined });
    saveRun(host, latest);
    const evidence = await boardEvidence(host);
    expect(evidence.refs.get(pull.key)).toMatchObject({ runId: latest.run_id });
    expect(evidence.refs.get(pull.key)?.sessionId).toBeUndefined();
  });

  it("does not guess the generation of ambiguous legacy runs from their mtimes", async () => {
    const host = fakeHost(); const pull = makePull();
    localRun(host, pull, "legacy-first", now - 120_000);
    localRun(host, pull, "legacy-second", now);
    expect((await boardEvidence(host)).runs.get(pull.key)).toBeUndefined();
  });
});
