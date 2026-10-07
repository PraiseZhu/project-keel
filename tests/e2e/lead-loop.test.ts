import { afterEach, describe, expect, it } from "vitest";
import { family } from "../../src/shared/fanout.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SC,
  addWorktree,
  cleanupRepos,
  leadLoop,
  makeE2eHost,
  makeWorld,
  startRun,
  type LeadRun,
} from "./helpers.ts";

afterEach(() => {
  cleanupRepos();
});

function kinds(run: LeadRun): string[] {
  return run.steps.map((s) => s.kind);
}

function workerModel(run: LeadRun, role: string): string | undefined {
  return run.models.find((m) => m.role === role)?.model;
}

describe("假主控 e2e：bug-fix 从 keel_run 到 done", () => {
  it("正常路径：作者 grok 族、验证者 gpt 族、真实测试、PR head=已验证 head → done", async () => {
    const world = makeWorld();
    const host = makeE2eHost(world);
    const started = await startRun(host, {
      goal: "修登录报错",
      repo_dir: world.repoDir,
      lead: "codex",
      sc: [...SC],
      scope: ["src/**"],
    });
    const run = await leadLoop(host, started, world);
    expect(run.next.kind, `未完成：${JSON.stringify(run.next)}`).toBe("done");
    expect(family(workerModel(run, "keel-worker") ?? "")).toBe("grok");
    expect(family(workerModel(run, "keel-verifier") ?? "")).toBe("gpt");
    expect(run.state.verdict?.level).toBe("unit-test-verified");
    expect(run.state.verdict?.head).toBe(world.prHead);
    expect(run.state.verdict?.by_family).toBe("gpt");
    expect(kinds(run)).toContain("setup");
    expect(kinds(run)).toContain("dispatch");
    expect(kinds(run)).toContain("wait");
  });

  it("同族验证者不能 done", async () => {
    const world = makeWorld();
    const host = makeE2eHost(world);
    const started = await startRun(host, {
      goal: "修登录报错",
      repo_dir: world.repoDir,
      lead: "codex",
      sc: [...SC],
      scope: ["src/**"],
    });
    const run = await leadLoop(host, started, world, {
      beforeStep: (next, state, h, runId) => {
        if (next.kind !== "wait") return;
        if (state.cursor !== "report-ready") return;
        if (!state.verdict?.by_family) return;
        state.verdict.by_family = "grok";
        h.files.set(`runs/${runId}/graph-state.json`, JSON.stringify(state));
      },
      stopWhen: (next) => next.kind === "decide" && next.gate_id === "done",
    });
    expect(run.next.kind).not.toBe("done");
    if (run.next.kind === "decide") {
      expect(run.next.question).toMatch(/作者族|模型族/);
    } else {
      expect(run.next.kind, `期望 decide/stop，实际 ${JSON.stringify(run.next)}`).toBe("stop");
    }
  });

  it("本地 head 未推送或与 PR head 不一致不能 done", async () => {
    const world = makeWorld({ syncPrHead: false });
    const host = makeE2eHost(world);
    const started = await startRun(host, {
      goal: "修登录报错",
      repo_dir: world.repoDir,
      lead: "codex",
      sc: [...SC],
      scope: ["src/**"],
    });
    const run = await leadLoop(host, started, world, {
      stopWhen: (next) => next.kind === "decide" && (next.gate_id === "done" || next.gate_id.startsWith("human:")),
    });
    expect(run.next.kind).not.toBe("done");
    const q = run.next.kind === "decide" ? run.next.question : run.next.kind === "stop" ? run.next.reason : "";
    expect(q).toMatch(/不一致|未推送|PR head|尚未完成/);
  });

  it("CI 红走 ci_red", async () => {
    const world = makeWorld({ ci: "red" });
    const host = makeE2eHost(world);
    const started = await startRun(host, {
      goal: "修登录报错",
      repo_dir: world.repoDir,
      lead: "codex",
      sc: [...SC],
      scope: ["src/**"],
    });
    const run = await leadLoop(host, started, world, {
      stopWhen: (_next, state) => state.cursor === "ci-rerun-once" || state.cursor === "fix-ci",
    });
    expect(run.next.kind).not.toBe("done");
    expect(["ci-rerun-once", "fix-ci"]).toContain(run.state.cursor);
  });

  it("写域越界 SCOPE_VIOLATION", async () => {
    const world = makeWorld({ outOfScope: true });
    const host = makeE2eHost(world);
    const started = await startRun(host, {
      goal: "修登录报错",
      repo_dir: world.repoDir,
      lead: "codex",
      sc: [...SC],
      scope: ["src/**"],
    });
    const run = await leadLoop(host, started, world);
    expect(run.last.ok).toBe(false);
    if (!run.last.ok) {
      expect(run.last.errorCode).toBe("SCOPE_VIOLATION");
      expect(run.last.message).toMatch(/越界|outside/);
    }
    expect(run.next.kind).not.toBe("done");
  });

  it("setup 回执缺 team_id 时返回 human:setup，并且不会派工", async () => {
    const world = makeWorld();
    const host = makeE2eHost(world);
    const started = await startRun(host, {
      goal: "修登录报错",
      repo_dir: world.repoDir,
      lead: "codex",
      sc: [...SC],
      scope: ["src/**"],
    });
    const run = await leadLoop(host, started, world, {
      setupTeamId: null,
      stopWhen: (next) => next.kind === "decide" && next.gate_id === "human:setup",
    });
    expect(run.next.kind).toBe("decide");
    if (run.next.kind === "decide") {
      expect(run.next.gate_id).toBe("human:setup");
      expect(run.next.question).toMatch(/team_id/);
    }
    expect(kinds(run)).not.toContain("dispatch");
    expect(run.models).toEqual([]);
    expect(run.state.team?.ready).not.toBe(true);
    expect(Object.values(run.state.nodes).some((n) => n.dispatch_key)).toBe(false);
  });

  it("人工门回答 stop 后 run 变为 stopped", async () => {
    const world = makeWorld();
    const host = makeE2eHost(world);
    const started = await startRun(host, {
      goal: "修登录报错",
      repo_dir: world.repoDir,
      lead: "codex",
      sc: [...SC],
      scope: ["src/**"],
    });
    const run = await leadLoop(host, started, world, {
      setupTeamId: null,
      gateAnswer: () => "stop",
    });
    expect(run.next.kind).toBe("stop");
    expect(run.state.status).toBe("stopped");
    expect(kinds(run)).not.toContain("dispatch");
  });

  it("accepted 之前已提交域外文件，final 返回 SCOPE_VIOLATION", async () => {
    const world = makeWorld({ outOfScopeBeforeAccepted: true });
    const host = makeE2eHost(world);
    const started = await startRun(host, {
      goal: "修登录报错",
      repo_dir: world.repoDir,
      lead: "codex",
      sc: [...SC],
      scope: ["src/**"],
    });
    const run = await leadLoop(host, started, world);
    expect(run.last.ok).toBe(false);
    if (!run.last.ok) {
      expect(run.last.errorCode).toBe("SCOPE_VIOLATION");
      expect(run.last.message).toMatch(/越界|outside/);
    }
    expect(run.next.kind).not.toBe("done");
  });
});

describe("假主控 e2e：investigation", () => {
  it("有 citation+SC 能 done，缺 citation 不能", async () => {
    const okWorld = makeWorld({ citation: "https://example.com/timeout" });
    const okHost = makeE2eHost(okWorld);
    const okStart = await startRun(okHost, {
      goal: "调查登录超时的原理",
      repo_dir: okWorld.repoDir,
      lead: "codex",
      playbook: "investigation",
      sc: [{ id: "SC-1", text: "给出根因引用" }],
    });
    const ok = await leadLoop(okHost, okStart, okWorld);
    expect(ok.next.kind, `有引用时应完成：${JSON.stringify(ok.next)}`).toBe("done");

    const badWorld = makeWorld();
    const badHost = makeE2eHost(badWorld);
    const badStart = await startRun(badHost, {
      goal: "调查登录超时的原理",
      repo_dir: badWorld.repoDir,
      lead: "codex",
      playbook: "investigation",
      sc: [{ id: "SC-1", text: "给出根因引用" }],
    });
    const bad = await leadLoop(badHost, badStart, badWorld, {
      stopWhen: (next) => next.kind === "decide" && next.gate_id === "done",
    });
    expect(bad.next.kind).not.toBe("done");
    if (bad.next.kind === "decide") expect(bad.next.question).toMatch(/引用/);
  });

  it("linked worktree 启动后调查期间被改动，不能判为 done", async () => {
    const world = makeWorld({ citation: "https://example.com/timeout" });
    const linked = addWorktree(world.repoDir, "inv-linked");
    const host = makeE2eHost(world);
    const started = await startRun(host, {
      goal: "调查登录超时的原理",
      repo_dir: linked,
      lead: "codex",
      playbook: "investigation",
      sc: [{ id: "SC-1", text: "给出根因引用" }],
    });
    writeFileSync(join(linked, "src/app.ts"), "mutated during investigation\n");
    const run = await leadLoop(host, started, world, {
      stopWhen: (next) => next.kind === "decide" && next.gate_id === "done",
    });
    expect(run.next.kind).not.toBe("done");
    const q = run.next.kind === "decide" ? run.next.question : run.next.kind === "stop" ? run.next.reason : "";
    expect(q).toMatch(/指纹|源码|Git/);
  });
});

