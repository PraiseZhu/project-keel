import { describe, expect, it } from "vitest";
import { TOOLS } from "../src/main/dispatch.ts";
import { makeContext } from "../src/main/context.ts";
import { runTool } from "../src/main/dispatch.ts";
import { GATES } from "../src/main/graph/gates.ts";
import { advanceEvidenceForNode, mapCreateWorkerReceipt, normalizeListWorkers, resolveLeadSessionId, resolveTeamId, verdictReportFromNode } from "../src/main/tools/keel.ts";
import { parseNodeReport } from "../src/main/graph/report.ts";
import { fakeHost } from "./helpers/fakeHost.ts";
import { graphStatePath, withRun } from "../src/main/store/runs.ts";
import type { GraphRunState } from "../src/main/graph/state.ts";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("plugin/ghost.json", "utf8"));
const profile = { lanes: [], routingPath: null, boardRepos: [], plansDir: null };

describe("resolveTeamId reads the real get_workspace_info shape", () => {
  const real = {
    ok: true,
    workflow: { workflow_id: "cmh0nested0001", lead_session_id: "e6831e58-77fe-48ea-a768-2b1da1e57364", status: "active" },
    workers: [{ label: "lead" }],
  };
  it("takes nested workflow.workflow_id and lead_session_id", () => {
    expect(resolveTeamId(real)).toBe("cmh0nested0001");
    expect(resolveLeadSessionId(real)).toBe("e6831e58-77fe-48ea-a768-2b1da1e57364");
  });
  it("treats workflow:null as no team", () => {
    expect(resolveTeamId({ ok: true, workflow: null, workers: [{ label: "w1" }] })).toBeUndefined();
    expect(resolveLeadSessionId({ ok: true, workflow: null, workers: [] })).toBeUndefined();
  });
});

describe("tool surface SC-9", () => {
  it("registers keel_run / report / wait / gate / status next to the legacy tools", () => {
    const names = Object.keys(TOOLS);
    for (const n of ["keel_run", "keel_report", "keel_wait", "keel_gate", "keel_status", "jev", "pstack_start", "pstack_decide", "pstack_ledger", "pr_status"]) {
      expect(names).toContain(n);
    }
    expect(names).toContain("fanout_plan");
    expect(names).toContain("fanout_ingest");
    expect(manifest.tools.map((t: { name: string }) => t.name).sort()).toEqual([...names].sort());
    expect(manifest.subscribe.topics).toContain("turn");
    expect(manifest.agent.background).toBe(true);
  });
});

describe("list_workers normalization", () => {
  it("marks complete only when ok, workers is an array, and count matches length", () => {
    expect(normalizeListWorkers({ ok: true, workers: [{ label: "a" }, { label: "b" }], count: 2 }).complete).toBe(true);
    expect(normalizeListWorkers({ ok: true, workers: [{ label: "a" }], count: 2 }).complete).toBe(false);
    expect(normalizeListWorkers({ ok: false, workers: [], count: 0 }).complete).toBe(false);
    expect(normalizeListWorkers({ ok: true, workers: "nope", count: 0 }).complete).toBe(false);
    expect(normalizeListWorkers({ ok: true, workers: [{ label: "a" }] }).complete).toBe(true);
    expect(normalizeListWorkers({ ok: true, workers: [], count: 0, team_id: "t1" }).team_id).toBe("t1");
  });
  it("maps create_worker receipts from real Orca fields", () => {
    const r = mapCreateWorkerReceipt({
      worker_id: "w1",
      worker_session_id: "s1",
      dispatch_outcome: { dispatched: true, wakeKind: "queued" },
      queued_message_id: "q1",
    });
    expect(r).toMatchObject({
      worker_id: "w1",
      worker_session_id: "s1",
      queued_message_id: "q1",
      dispatch_outcome: { created: true, delivered: false, queued: true },
    });
  });
});

function nodeFake(kind: "change" | "pr" | "investigation" | "occupied") {
  return (method: string, params: any) => {
    if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "feat/x", head: "abc" } };
    if (method === "git/content-fingerprint") return { ok: true, result: { head: "abc", status_digest: "d", content_hash: "h" } };
    if (method === "worktree/create") {
      if (kind === "occupied") return { ok: true, result: { occupied: "/repo/.worktrees/other", branch: params.branch } };
      return { ok: true, result: { path: `/repo/.worktrees/keel-${params.name}`, existing: params.existing === true } };
    }
    return { ok: false, message: "UNEXPECTED " + method };
  };
}

describe("keel_run graph types", () => {
  it("change graphs create a keel-* worktree and start with setup", async () => {
    const h = fakeHost({ node: nodeFake("change") });
    const r: any = await runTool(makeContext(h, "c1", profile), "keel_run", {
      goal: "修登录报错", repo_dir: "/repo", lead: "codex",
    });
    expect(r.ok).toBe(true);
    expect(r.result.profile.id).toBe("sol");
    expect(r.result.next.kind).toBe("setup");
    expect(h.nodeCalls.some((c) => c.method === "worktree/create" && (c.params as { existing?: boolean }).existing !== true)).toBe(true);
    expect([...h.files.keys()].some((k) => k.startsWith("runs/") && k.endsWith("graph-state.json"))).toBe(true);
    expect(h.files.has("runs/active.json")).toBe(true);
    expect(h.broadcasts.some((b: any) => b.type === "graph-delta")).toBe(true);
  });
  it("investigation does not create a worktree and records the starting fingerprint", async () => {
    const h = fakeHost({ node: nodeFake("investigation") });
    const r: any = await runTool(makeContext(h, "c1", profile), "keel_run", {
      goal: "调查登录超时的原理", repo_dir: "/repo", lead: "codex", playbook: "investigation",
    });
    expect(r.ok).toBe(true);
    expect(h.nodeCalls.some((c) => c.method === "worktree/create")).toBe(false);
    expect(h.nodeCalls.some((c) => c.method === "git/content-fingerprint")).toBe(true);
  });
  it("pr type checks out the existing branch and stops when occupied", async () => {
    const okHost = fakeHost({ node: nodeFake("pr") });
    const ok: any = await runTool(makeContext(okHost, "c1", profile), "keel_run", {
      goal: "推进已有 PR", repo_dir: "/repo", lead: "codex", pr: 12, playbook: "pr",
    });
    expect(ok.ok).toBe(true);
    expect(okHost.nodeCalls.some((c) => c.method === "worktree/create" && (c.params as { existing?: boolean }).existing === true)).toBe(true);
    const blocked = fakeHost({ node: nodeFake("occupied") });
    const stop: any = await runTool(makeContext(blocked, "c1", profile), "keel_run", {
      goal: "推进已有 PR", repo_dir: "/repo", lead: "codex", pr: 12, playbook: "pr",
    });
    expect(stop.result.next.kind).toBe("stop");
    expect(stop.result.next.reason).toContain("检出");
  });
});

describe("pstack_start migration", () => {
  it("maps task to keel_run when repo_dir is present", async () => {
    const h = fakeHost({ node: nodeFake("change") });
    const r: any = await runTool(makeContext(h, "c1", profile), "pstack_start", {
      task: "修登录报错", repo_dir: "/repo", lead: "codex",
    });
    expect(r.ok).toBe(true);
    expect(r.result.next.kind).toBe("setup");
  });
});

async function startChange() {
  const h = fakeHost({ node: nodeFake("change") });
  const started: any = await runTool(makeContext(h, "c1", profile), "keel_run", {
    goal: "修登录报错", repo_dir: "/repo", lead: "codex",
  });
  return { h, started };
}

describe("report / status / gate", () => {
  it("setup report then dispatch carries create_worker as-is", async () => {
    const { h, started } = await startChange();
    const setup: any = await runTool(makeContext(h, "c2", profile), "keel_report", {
      run_id: started.result.run_id,
      phase: "setup",
      outcome: { worker_permission_mode: "bypassPermissions", team_id: "t1" },
    });
    expect(setup.ok).toBe(true);
    expect(setup.result.next.kind).toBe("dispatch");
    expect(setup.result.next.create_worker.initial_task).toContain("GOAL");
    expect(setup.result.next.create_worker.initial_task).toContain("FORBIDDEN");
    const accepted: any = await runTool(makeContext(h, "c3", profile), "keel_report", {
      run_id: started.result.run_id,
      phase: "accepted",
      dispatch_key: setup.result.next.dispatch_key,
      worker_id: "w1",
      worker_session_id: "s1",
      dispatch_outcome: { dispatched: true, wakeKind: "immediate" },
    });
    expect(accepted.ok).toBe(true);
    expect(["wait", "reconcile", "dispatch", "recover"]).toContain(accepted.result.next.kind);
  });
  it("keel_status lists the run and keel_gate stores an answer", async () => {
    const { h, started } = await startChange();
    const st: any = await runTool(makeContext(h, "c2", profile), "keel_status", {});
    expect(st.result.runs.some((r: any) => r.run_id === started.result.run_id)).toBe(true);
    const g: any = await runTool(makeContext(h, "c3", profile), "keel_gate", {
      run_id: started.result.run_id, gate_id: "G-retry", answer: "retry", reason: "再试",
    });
    expect(g.ok).toBe(true);
    expect(g.result.answer).toBe("retry");
  });
  it("records investigation start_state in graph-state.json", async () => {
    const h = fakeHost({ node: nodeFake("investigation") });
    const r: any = await runTool(makeContext(h, "c1", profile), "keel_run", {
      goal: "调查登录超时的原理", repo_dir: "/repo", lead: "codex", playbook: "investigation",
    });
    const path = [...h.files.keys()].find((k) => k.endsWith("graph-state.json"));
    expect(path).toBeTruthy();
    const state = JSON.parse(h.files.get(path!)!);
    expect(state.start_state).toEqual({ head: "abc", status_digest: "d", content_hash: "h" });
    expect(state.worktree).toBeUndefined();
    expect(r.result.run_id).toBe(state.run_id);
  });
  it("fingerprint RPC error is unknown/incomplete, never a synthetic hash", async () => {
    const h = fakeHost({
      node: (method: string) => {
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "main", head: "abc" } };
        if (method === "git/content-fingerprint") return { ok: false, message: "GIT_ERROR: not a git repo" };
        return { ok: false, message: "UNEXPECTED " + method };
      },
    });
    const r: any = await runTool(makeContext(h, "c1", profile), "keel_run", {
      goal: "调查登录超时的原理", repo_dir: "/repo", lead: "codex", playbook: "investigation",
    });
    expect(r).toMatchObject({ ok: false, errorCode: "FINGERPRINT_UNKNOWN" });
    expect([...h.files.keys()].some((k) => k.endsWith("graph-state.json"))).toBe(false);
  });
});

describe("G-advance evidence adapters", () => {
  it("verify-same-surface advances when the original tests now pass, stays when they fail", () => {
    const ok = advanceEvidenceForNode({
      nodeId: "verify-same-surface",
      ran: [{ cmd: "npm test", exit_code: 0 }],
      head_matches: true,
      new_report: true,
    });
    expect(ok.exit_code).toBe(0);
    expect(GATES["G-advance"].deterministic(ok)).toBe("advance");
    const red = advanceEvidenceForNode({
      nodeId: "verify-same-surface",
      ran: [{ cmd: "npm test", exit_code: 1 }],
      head_matches: true,
      new_report: true,
    });
    expect(red.exit_code).toBe(1);
    expect(GATES["G-advance"].deterministic(red)).toBe("stay");
  });
  it("equivalence advances when the check commands pass, stays when they fail", () => {
    const ok = advanceEvidenceForNode({
      nodeId: "equivalence",
      ran: [{ cmd: "npm run equiv", exit_code: 0 }],
      head_matches: true,
      new_report: true,
    });
    expect(ok.exit_code).toBe(0);
    expect(GATES["G-advance"].deterministic(ok)).toBe("advance");
    const red = advanceEvidenceForNode({
      nodeId: "equivalence",
      ran: [{ cmd: "npm run equiv", exit_code: 1 }],
      head_matches: true,
      new_report: true,
    });
    expect(red.exit_code).toBe(1);
    expect(GATES["G-advance"].deterministic(red)).toBe("stay");
  });
  it("research omits exit_code; a head mismatch stays, otherwise Jev/lead decide", () => {
    const ok = advanceEvidenceForNode({
      nodeId: "research",
      ran: [{ cmd: "rg foo src", exit_code: 1 }],
      head_matches: true,
      new_report: true,
    });
    expect(ok).not.toHaveProperty("exit_code");
    expect(GATES["G-advance"].deterministic(ok)).toBeUndefined();
    const mismatch = advanceEvidenceForNode({
      nodeId: "research",
      ran: [{ cmd: "rg foo src", exit_code: 0 }],
      head_matches: false,
      new_report: true,
    });
    expect(mismatch).not.toHaveProperty("exit_code");
    expect(GATES["G-advance"].deterministic(mismatch)).toBe("stay");
  });
  it("does not rewrite ran[] and does not invert reproduce", () => {
    const ran = [{ cmd: "npm test", exit_code: 1 }];
    const repro = advanceEvidenceForNode({ nodeId: "reproduce", ran, head_matches: true, new_report: true });
    expect(repro).not.toHaveProperty("exit_code");
    expect(ran[0]!.exit_code).toBe(1);
  });
});

describe("ui_evidence passthrough", () => {
  it("keeps worker ui_evidence and does not invent surface", () => {
    const withUi = parseNodeReport(JSON.stringify({
      dispatch_key: "run:node:1", status: "done", summary: "ok", files_changed: [],
      ran: [{ cmd: "npx playwright test", exit_code: 0 }],
      ui_evidence: ["shots/home.png"],
      surface: "live-ui",
    }), "run:node:1");
    expect(withUi.ui_evidence).toEqual(["shots/home.png"]);
    expect(withUi.surface).toBe("live-ui");
    const mapped = verdictReportFromNode(withUi);
    expect(mapped.ui_evidence).toEqual(["shots/home.png"]);
    expect(mapped.surface).toBe("live-ui");

    const bare = parseNodeReport(JSON.stringify({
      dispatch_key: "run:node:1", status: "done", summary: "ok", files_changed: [],
      ran: [{ cmd: "npm test", exit_code: 0 }],
    }), "run:node:1");
    expect(bare).not.toHaveProperty("ui_evidence");
    expect(bare).not.toHaveProperty("surface");
    const mappedBare = verdictReportFromNode(bare);
    expect(mappedBare).not.toHaveProperty("ui_evidence");
    expect(mappedBare).not.toHaveProperty("surface");
  });
});

describe("reconcile / recover / setup wiring", () => {
  it("keeps getRun and readMessages as-is on reconcile", async () => {
    const h = fakeHost({ node: nodeFake("change") });
    const started: any = await runTool(makeContext(h, "c1", profile), "keel_run", {
      goal: "修登录报错", repo_dir: "/repo", lead: "codex",
    });
    const runId = started.result.run_id as string;
    const key = `${runId}:research:1`;
    await withRun(h, runId, (raw) => {
      const s = raw as unknown as GraphRunState;
      s.nodes.research = {
        status: "active",
        attempts: 1,
        dispatch_key: key,
        dispatch_state: "reconciling",
        task: { create_request_key: "create:k", create_body: {}, phase: "create", task_id: "task-1" },
      };
      s.cursor = "research";
    });
    const r: any = await runTool(makeContext(h, "c2", profile), "keel_report", {
      run_id: runId,
      phase: "reconcile",
      dispatch_key: key,
      queries_result: {
        getRun: { ok: true, complete: true, run_id: "plugin-run", status: "running" },
        readMessages: { ok: true, complete: true },
      },
    });
    expect(r.ok).toBe(true);
    const st = JSON.parse(h.files.get(graphStatePath(runId))!) as GraphRunState;
    expect(st.nodes.research?.dispatch_state).toBe("running");
  });
  async function plantRecover(h: ReturnType<typeof fakeHost>, action: "verify_stopped" | "archive" = "verify_stopped") {
    const started: any = await runTool(makeContext(h, "c1", profile), "keel_run", {
      goal: "修登录报错", repo_dir: "/repo", lead: "codex",
    });
    const runId = started.result.run_id as string;
    const key = `${runId}:implement:1`;
    await withRun(h, runId, (raw) => {
      const s = raw as unknown as GraphRunState;
      s.nodes.implement = {
        status: "active",
        attempts: 1,
        dispatch_key: key,
        dispatch_state: "running",
        expected_recover_action: action,
        worker_id: "w1",
        worker_label: "keel-impl",
        team_id: "t1",
      };
    });
    return { runId, key };
  }
  it("surfaces RECOVER_ACTION_MISMATCH when the recover action is wrong", async () => {
    const h = fakeHost({ node: nodeFake("change") });
    const { runId, key } = await plantRecover(h, "verify_stopped");
    const mismatch: any = await runTool(makeContext(h, "c2", profile), "keel_report", {
      run_id: runId, phase: "recover", dispatch_key: key, action: "archive", action_result: { ok: true },
    });
    expect(mismatch).toMatchObject({ ok: false, errorCode: "RECOVER_ACTION_MISMATCH" });
  });
  it("verify_stopped does not treat archived as stopped, and accepts idle-or-absent workers", async () => {
    const h = fakeHost({ node: nodeFake("change") });
    const { runId, key } = await plantRecover(h);
    const archived: any = await runTool(makeContext(h, "c3", profile), "keel_report", {
      run_id: runId,
      phase: "recover",
      dispatch_key: key,
      action: "verify_stopped",
      action_result: { ok: true, complete: true, status: "archived", list_workers: { ok: true, complete: true, team_id: "t1", workers: [{ label: "keel-impl", worker_id: "w1", status: "archived" }] } },
    });
    expect(archived.ok).toBe(true);
    expect(archived.result.next.kind).toBe("decide");
    expect(archived.result.next.gate_id).toBe("human:verify_stopped");
    const h2 = fakeHost({ node: nodeFake("change") });
    const planted = await plantRecover(h2);
    const stopped: any = await runTool(makeContext(h2, "c4", profile), "keel_report", {
      run_id: planted.runId,
      phase: "recover",
      dispatch_key: planted.key,
      action: "verify_stopped",
      action_result: {
        list_workers: { ok: true, complete: true, team_id: "t1", workers: [] },
        worker_status: { ok: true, complete: true, status: "idle" },
      },
    });
    expect(stopped.ok).toBe(true);
    expect(stopped.result.next.kind).not.toBe("decide");
  });
  it("setup records team_id and lead session", async () => {
    const h = fakeHost({ node: nodeFake("change") });
    const started: any = await runTool(makeContext(h, "c1", profile), "keel_run", {
      goal: "修登录报错", repo_dir: "/repo", lead: "codex",
    });
    const runId = started.result.run_id as string;
    const r: any = await runTool(makeContext(h, "c2", profile), "keel_report", {
      run_id: runId,
      phase: "setup",
      outcome: { worker_permission_mode: "bypassPermissions", team_id: "team-9" },
      session_id: "sol-sess",
    });
    expect(r.ok).toBe(true);
    const st = JSON.parse(h.files.get(graphStatePath(runId))!) as GraphRunState;
    expect(st.team).toMatchObject({ ready: true, team_id: "team-9", lead_session_id: "sol-sess" });
  });
  it("setup falls back to get_workspace_info workflow id and rejects a missing team_id", async () => {
    const h = fakeHost({ node: nodeFake("change") });
    const started: any = await runTool(makeContext(h, "c1", profile), "keel_run", {
      goal: "修登录报错", repo_dir: "/repo", lead: "codex",
    });
    const runId = started.result.run_id as string;
    const viaWorkflow: any = await runTool(makeContext(h, "c2", profile), "keel_report", {
      run_id: runId,
      phase: "setup",
      outcome: { worker_permission_mode: "bypassPermissions" },
      get_workspace_info: { workflow_id: "wf-7" },
    });
    expect(viaWorkflow.ok).toBe(true);
    expect(JSON.parse(h.files.get(graphStatePath(runId))!).team.team_id).toBe("wf-7");
    const h2 = fakeHost({ node: nodeFake("change") });
    const s2: any = await runTool(makeContext(h2, "c1", profile), "keel_run", {
      goal: "修登录报错", repo_dir: "/repo", lead: "codex",
    });
    const missing: any = await runTool(makeContext(h2, "c2", profile), "keel_report", {
      run_id: s2.result.run_id,
      phase: "setup",
      outcome: { worker_permission_mode: "bypassPermissions" },
    });
    expect(missing.ok).toBe(true);
    expect(missing.result.next).toMatchObject({ kind: "decide", gate_id: "human:setup" });
  });
  it("setup reads nested get_workspace_info.workflow.workflow_id and treats workflow:null as no team", async () => {
    const h = fakeHost({ node: nodeFake("change") });
    const started: any = await runTool(makeContext(h, "c1", profile), "keel_run", {
      goal: "修登录报错", repo_dir: "/repo", lead: "codex",
    });
    const runId = started.result.run_id as string;
    const real = {
      ok: true,
      workflow: { workflow_id: "cmh0nested0001", lead_session_id: "e6831e58-77fe-48ea-a768-2b1da1e57364", status: "active" },
      workers: [{ label: "lead" }],
    };
    const viaNested: any = await runTool(makeContext(h, "c2", profile), "keel_report", {
      run_id: runId,
      phase: "setup",
      outcome: { worker_permission_mode: "bypassPermissions" },
      get_workspace_info: real,
    });
    expect(viaNested.ok).toBe(true);
    expect(JSON.parse(h.files.get(graphStatePath(runId))!).team).toMatchObject({
      ready: true,
      team_id: "cmh0nested0001",
      lead_session_id: "e6831e58-77fe-48ea-a768-2b1da1e57364",
    });
    const h2 = fakeHost({ node: nodeFake("change") });
    const s2: any = await runTool(makeContext(h2, "c1", profile), "keel_run", {
      goal: "修登录报错", repo_dir: "/repo", lead: "codex",
    });
    const workerSession: any = await runTool(makeContext(h2, "c2", profile), "keel_report", {
      run_id: s2.result.run_id,
      phase: "setup",
      outcome: { worker_permission_mode: "bypassPermissions" },
      get_workspace_info: { ok: true, workflow: null, workers: [{ label: "w1" }] },
    });
    expect(workerSession.ok).toBe(true);
    expect(workerSession.result.next).toMatchObject({ kind: "decide", gate_id: "human:setup" });
  });
  it("verify_stopped without matching team_id is not stopped", async () => {
    const h = fakeHost({ node: nodeFake("change") });
    const planted = await plantRecover(h);
    const r: any = await runTool(makeContext(h, "c2", profile), "keel_report", {
      run_id: planted.runId,
      phase: "recover",
      dispatch_key: planted.key,
      action: "verify_stopped",
      action_result: {
        list_workers: { ok: true, complete: true, workers: [] },
        worker_status: { ok: true, complete: true, status: "idle" },
      },
    });
    expect(r.ok).toBe(true);
    expect(r.result.next).toMatchObject({ kind: "decide", gate_id: "human:verify_stopped" });
  });
});
