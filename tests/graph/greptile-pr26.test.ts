import { afterEach, describe, expect, it } from "vitest";
import { makeContext } from "../../src/main/context.ts";
import { runTool } from "../../src/main/dispatch.ts";
import type { GraphRunState, Next } from "../../src/main/graph/state.ts";
import { graphStatePath } from "../../src/main/store/runs.ts";
import { DEFAULT_MANUAL } from "../../src/shared/manual/schema.ts";
import {
  SC,
  cleanupRepos,
  leadLoop,
  makeE2eHost,
  makeWorld,
  startRun,
} from "../e2e/helpers.ts";
import { fakeHost } from "../helpers/fakeHost.ts";

afterEach(cleanupRepos);

const profile = { lanes: [], routingPath: null, boardRepos: [], plansDir: null };

function nextOf(r: { ok: boolean; result?: unknown; errorCode?: string; message?: string }): Next {
  if (!r.ok) throw new Error(`tool failed ${r.errorCode}: ${r.message}`);
  const n = (r.result as { next?: Next }).next;
  if (!n) throw new Error("missing next");
  return n;
}

describe("Greptile PR26 threads on 93d19dc", () => {
  it("1 验证基准：变更 run 不预先写 verdict.base_sha，verifier final 仍能建 verdict 并 done", async () => {
    const world = makeWorld();
    const host = makeE2eHost(world);
    const started = await startRun(host, {
      goal: "修登录报错", repo_dir: world.repoDir, lead: "codex", sc: [...SC], scope: ["src/**"],
    });
    const afterStart = JSON.parse(host.files.get(graphStatePath(started.run_id))!) as GraphRunState;
    expect(afterStart.verdict?.base_sha).toBeUndefined();
    const run = await leadLoop(host, started, world);
    expect(run.next.kind, `未完成：${JSON.stringify(run.next)}`).toBe("done");
    expect(run.state.verdict?.base_sha).toMatch(/^[0-9a-f]{40}$/i);
    expect(run.state.verdict?.level).toBe("unit-test-verified");
  });

  it("2 门答案：G-route decide 经 keel_gate 后不再重复同一问题", async () => {
    const h = fakeHost({
      node: (method: string) => {
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "main", head: "a".repeat(40), gh_repo: "acme/app" } };
        if (method === "worktree/create") return { ok: true, result: { path: "/repo/.worktrees/x" } };
        return { ok: false, message: method };
      },
    });
    const started: any = await runTool(makeContext(h, "c1", profile), "keel_run", {
      goal: "重构登录功能", repo_dir: "/repo", scope: ["src/**", "tests/**"], lead: "codex",
    });
    expect(started.ok).toBe(true);
    expect(started.result.next.kind).toBe("decide");
    expect(started.result.next.gate_id).toBe("G-route");
    const gated: any = await runTool(makeContext(h, "c2", profile), "keel_gate", {
      run_id: started.result.run_id, gate_id: "G-route", answer: "refactoring",
    });
    expect(gated.ok).toBe(true);
    expect(gated.result.next.kind).not.toBe("decide");
    expect(gated.result.next.kind).toBe("setup");
  });

  it("3 非 PR 等待：调查图 report 经 keel_wait 能结束并 done", async () => {
    const world = makeWorld({ citation: "https://example.com/timeout" });
    const host = makeE2eHost(world);
    const started = await startRun(host, {
      goal: "调查登录超时的原理", repo_dir: world.repoDir, lead: "codex",
      playbook: "investigation", sc: [{ id: "SC-1", text: "给出根因引用" }],
    });
    const run = await leadLoop(host, started, world);
    expect(run.next.kind, `卡住：${JSON.stringify(run.next)}`).toBe("done");
    expect(run.steps.some((s) => s.kind === "wait")).toBe(true);
  });

  it("4 插件 accepted：task_id/revision 能推进到 send，不对账", async () => {
    const h = fakeHost({
      node: (method: string) => {
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "main", head: "a".repeat(40), gh_repo: "o/r" } };
        if (method === "git/content-fingerprint") return { ok: true, result: { head: "a".repeat(40), status_digest: "d", content_hash: "h" } };
        return { ok: false, message: method };
      },
    });
    const started: any = await runTool(makeContext(h, "c1", profile), "keel_run", {
      goal: "调查登录超时的原理", repo_dir: "/repo", scope: ["src/**", "tests/**"], lead: "codex", playbook: "investigation",
      sc: [{ id: "SC-1", text: "给出根因引用" }],
    });
    expect(started.ok).toBe(true);
    let next = nextOf(started);
    expect(next.kind).toBe("setup");
    const setup: any = await runTool(makeContext(h, "c2", profile), "keel_report", {
      run_id: started.result.run_id, phase: "setup",
      outcome: { worker_permission_mode: "bypassPermissions", team_id: "t1" },
    });
    next = nextOf(setup);
    expect(next.kind).toBe("dispatch");
    if (next.kind !== "dispatch" || !next.create_worker) throw new Error("explore worker");
    const exploreKey = next.dispatch_key;
    const accExplore: any = await runTool(makeContext(h, "c3", profile), "keel_report", {
      run_id: started.result.run_id, phase: "accepted", dispatch_key: exploreKey,
      worker_id: "w1", worker_session_id: "ws1", dispatch_outcome: { dispatched: true, wakeKind: "immediate" },
    });
    expect(accExplore.ok).toBe(true);
    const finExplore: any = await runTool(makeContext(h, "c4", profile), "keel_report", {
      run_id: started.result.run_id, phase: "final", dispatch_key: exploreKey,
      inline_report: { status: "done", summary: "explore ok", files_changed: [], ran: [], sc_evidence: { "SC-1": true }, citation: "https://example.com/x" },
    });
    next = nextOf(finExplore);
    expect(next.kind).toBe("dispatch");
    if (next.kind !== "dispatch") throw new Error("research dispatch");
    expect(next.plugin_task?.phase).toBe("create");
    const accepted: any = await runTool(makeContext(h, "c5", profile), "keel_report", {
      run_id: started.result.run_id, phase: "accepted", dispatch_key: next.dispatch_key,
      task_id: "task-9", revision: 3,
    });
    expect(accepted.ok).toBe(true);
    next = nextOf(accepted);
    expect(next.kind, `对账了：${JSON.stringify(next)}`).toBe("dispatch");
    if (next.kind !== "dispatch") throw new Error("dispatch");
    expect(next.plugin_task?.phase).toBe("send");
    expect(next.plugin_task?.task_id).toBe("task-9");
    const st = JSON.parse(h.files.get(graphStatePath(started.result.run_id))!) as GraphRunState;
    expect(st.nodes.research?.task).toMatchObject({ task_id: "task-9", revision: 3, phase: "send" });
  });

  it("5 已提交越域：accepted 前 commit 域外文件，final 仍 SCOPE_VIOLATION", async () => {
    const world = makeWorld({ outOfScopeBeforeAccepted: true });
    const host = makeE2eHost(world);
    const started = await startRun(host, {
      goal: "修登录报错", repo_dir: world.repoDir, lead: "codex", sc: [...SC], scope: ["src/**"],
    });
    const run = await leadLoop(host, started, world);
    expect(run.last.ok).toBe(false);
    if (!run.last.ok) {
      expect(run.last.errorCode).toBe("SCOPE_VIOLATION");
      expect(run.last.message).toMatch(/越界|outside/);
    }
    expect(run.next.kind).not.toBe("done");
  });

  it("6 Profile 选择：无默认方案时回答 profile 门能创建 run 并继续", async () => {
    const h = fakeHost({
      kv: { manual: { ...DEFAULT_MANUAL, defaults_by_harness: { codex: "sol", "claude-code": "grok" } } },
      node: (method: string) => {
        if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "main", head: "a".repeat(40), gh_repo: "acme/app" } };
        if (method === "worktree/create") return { ok: true, result: { path: "/repo/.worktrees/x" } };
        return { ok: false, message: method };
      },
    });
    const started: any = await runTool(makeContext(h, "c1", profile), "keel_run", {
      goal: "修登录报错", repo_dir: "/repo", scope: ["src/**", "tests/**"], lead: "pi",
    });
    expect(started.ok).toBe(true);
    expect(started.result.next.kind).toBe("decide");
    expect(started.result.next.gate_id).toBe("profile");
    const runId = started.result.run_id as string;
    const answer = started.result.next.options[0] as string;
    const gated: any = await runTool(makeContext(h, "c2", profile), "keel_gate", {
      run_id: runId, gate_id: "profile", answer,
    });
    expect(gated.ok, gated.message).toBe(true);
    expect(gated.result.next.kind).not.toBe("decide");
    const st = JSON.parse(h.files.get(graphStatePath(runId))!) as GraphRunState;
    expect(st.spec_id).toBeTruthy();
    expect(st.profile_id).toBe(answer);
  });
});
