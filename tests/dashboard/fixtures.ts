import { initGraphState, type GraphRunState } from "../../src/main/graph/state.ts";
import { pullKey, pullUrl, type RemotePull } from "../../src/shared/dashboard.ts";
import { fakeHost, type FakeHost } from "../helpers/fakeHost.ts";

export function makePull(number = 1, overrides: Partial<RemotePull> = {}): RemotePull {
  const repo = overrides.repo ?? "sample/keel";
  return {
    key: pullKey(repo, number), repo, number, title: `示例任务 ${number}`, url: pullUrl(repo, number), author: "demo",
    state: "OPEN", isDraft: false, updatedAt: new Date(Date.now() - number * 60_000).toISOString(), headSha: "a".repeat(40),
    checks: "PENDING", review: "APPROVED", mergeable: "MERGEABLE", mergeState: "UNSTABLE",
    ci: overrides.checks === "SUCCESS" ? { passed: 5, failed: 0, pending: 0, total: 5, complete: true } : { passed: 3, failed: 0, pending: 2, total: 5, complete: true }, ...overrides,
  };
}

export function makeRun(pull: RemotePull, cursor: string, now: number, overrides: Partial<GraphRunState> = {}): GraphRunState {
  const runId = `board-${pull.repo.replace(/[^a-z0-9]/gi, "-").toLowerCase()}-${pull.number}`;
  const state = initGraphState({ run_id: runId, spec_id: "feature", profile_id: "sol", lead_harness: "codex", task_type: "feature", entry: cursor,
    goal: pull.title, pr_binding: { repo: pull.repo, number: pull.number, head_sha: pull.headSha }, sol_session_id: "lead", now });
  state.status = "running";
  state.nodes[cursor] = { status: "active", attempts: 1, dispatch_key: `${runId}:${cursor}:1`, dispatch_state: "running", dispatch_state_at: now, started_at: now };
  return Object.assign(state, overrides);
}

export function saveRun(host: FakeHost, run: GraphRunState): void {
  host.files.set(`runs/${run.run_id}/graph-state.json`, JSON.stringify(run));
}

export function dashboardFixture(now = Date.now()) {
  const rows = [
    makePull(42, { title: "把复杂操作收拢成清晰的工作流", isDraft: true }),
    makePull(43, { title: "梳理新的键盘导航方案", isDraft: true }),
    makePull(42, { repo: "sample/client", key: pullKey("sample/client", 42), url: pullUrl("sample/client", 42), title: "修复重复卡片与排序", isDraft: true }),
    makePull(318, { repo: "sample/client", key: pullKey("sample/client", 318), url: pullUrl("sample/client", 318), title: "让筛选条件跟随状态更新" }),
    makePull(315, { repo: "sample/app", key: pullKey("sample/app", 315), url: pullUrl("sample/app", 315), title: "确认权限提示的交互边界", checks: "SUCCESS", ci: { passed: 5, failed: 0, pending: 0, total: 5, complete: true } }),
    makePull(40, { title: "核验这一版的功能与回归", checks: "SUCCESS" }),
    makePull(39, { title: "已完成检查，等待后续确认", checks: "SUCCESS", ci: { passed: 5, failed: 0, pending: 0, total: 5, complete: true } }),
    makePull(312, { repo: "sample/app", key: pullKey("sample/app", 312), url: pullUrl("sample/app", 312), title: "交接后的评审由盯梢接手" }),
    makePull(20, { title: "历史 PR：已合并的改进", state: "MERGED", checks: "SUCCESS" }),
  ];
  const controls = { fail: false, owner: "demo", pageSize: 4, rows };
  const host = fakeHost({ node: async (method, params) => {
    const args = params as Record<string, unknown>;
    if (method === "pr/board") {
      if (controls.fail) return { ok: false, errorCode: "GH_ERROR", message: "GH_ERROR: fixture connection offline" };
      const filtered = controls.rows.filter((row) => args.scope === "all" || row.state === "OPEN");
      const offset = Number(args.cursor ?? 0);
      return { ok: true, result: { owner: controls.owner, total: filtered.length, rows: filtered.slice(offset, offset + controls.pageSize), nextCursor: offset + controls.pageSize < filtered.length ? String(offset + controls.pageSize) : null, remaining: 4000 } };
    }
    if (method === "pr/board-linked") {
      const row = controls.rows.find((candidate) => candidate.repo === args.repo && candidate.number === args.number);
      return row ? { ok: true, result: row } : { ok: false, message: "BOARD_PR_UNAVAILABLE: fixture missing" };
    }
    return { ok: false, message: `PREVIEW_BLOCKED: ${method}` };
  } });
  host.clock.t = now;
  const feature = makeRun(rows[0]!, "implement", now - 40_000);
  feature.progress = { nodeId: "implement", dispatchKey: feature.nodes.implement!.dispatch_key!, step: 4, at: now - 40_000 };
  saveRun(host, feature);
  const plan = makeRun(rows[1]!, "architect-plan", now - 30_000);
  plan.progress = { nodeId: "architect-plan", dispatchKey: plan.nodes["architect-plan"]!.dispatch_key!, step: 2, at: now - 30_000 };
  saveRun(host, plan);
  const bug = makeRun(rows[2]!, "implement", now - 70_000, { task_type: "bug-fix", spec_id: "bug-fix" });
  bug.progress = { nodeId: "implement", dispatchKey: bug.nodes.implement!.dispatch_key!, step: 3, at: now - 70_000 };
  saveRun(host, bug);
  const waiting = makeRun(rows[3]!, "wait-ci", now - 90_000);
  waiting.nodes["wait-ci"]!.dispatch_state = undefined;
  saveRun(host, waiting);
  const gate = makeRun(rows[4]!, "g-accept", now - 300_000, { status: "await_sol", next: { kind: "decide", gate_id: "g-accept", question: "这个交互是否符合你确认的边界？需要主控核对后继续。", options: ["adopt", "revise"] } });
  saveRun(host, gate);
  saveRun(host, makeRun(rows[5]!, "astra-final-review", now - 25_000));
  saveRun(host, makeRun(rows[6]!, "report-ready", now - 120_000, { status: "done" }));
  host.files.set("handoff/sample__app__312.json", JSON.stringify({ repo: "sample/app", number: 312, status: "complete", at: new Date(now - 360_000).toISOString(), head_sha: "a".repeat(40), gate: {}, evidence: {} }));
  return { host, controls };
}
