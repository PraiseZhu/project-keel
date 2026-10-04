import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { planLanes } from "../../src/shared/fanout.ts";
import { dispatch } from "../../src/node/rpc.ts";
import "../../src/node/extensions.ts";
import { tiersFrom } from "../../src/node/fanout/fanout.ts";
import { promptFor } from "../../src/main/fanout/spec.ts";
import { explicitFanout } from "../../src/main/tools/pstack.ts";

// Gaps found in the S3/S5 replays (docs/replays/S3.md, S5.md).

const routing = {
  updated: "2026-01-01",
  execute: { agent: "pi", model: "grok-9", effort: "high", fallbacks: [] },
  review: { agent: "claude-code", model: "z/glm-9", effort: "max", fallbacks: [], when_lead: { "claude-code": { agent: "claude-code", model: "openai/gpt-9", effort: "high", fallbacks: [] } } },
};

describe("explicit multi-model requests", () => {
  it("flags interrogate when the user names several models for a review", () => {
    expect(explicitFanout("用三个模型审查 PR #2 的 diff").interrogate).toBe(true);
    expect(explicitFanout("跑一次 interrogate").interrogate).toBe(true);
  });
  it("flags arena when the user asks for candidates", () => {
    expect(explicitFanout("用 arena 做 3 个候选实现").arena).toBe(true);
    expect(explicitFanout("做三个候选方案再选").arena).toBe(true);
  });
  it("stays quiet for ordinary tasks", () => {
    expect(explicitFanout("修一下登录按钮的报错")).toEqual({ interrogate: false, arena: false });
    expect(explicitFanout("模型说明书里换一下审核模型")).toEqual({ interrogate: false, arena: false });
  });
});

describe("lane prompts", () => {
  const t = tiersFrom(routing as any, "claude-code");
  it("read-only reviewers are not told to fix anything", () => {
    const [r] = planLanes("interrogate", t, {}).map((l) => ({ ...l, working_dir: "/repo", branch: null }));
    const text = promptFor("interrogate", r!, { task: "review x", rubric: "rubric", baseSha: "b0", sceneHead: "h1" });
    expect(text).toContain("git diff b0...h1");
    expect(text).toContain("只读");
    expect(text).not.toMatch(/只修/);
  });
  it("write candidates do the task instead of a review-fix rule", () => {
    const c = planLanes("arena", t, {}).find((l) => l.write)!;
    const text = promptFor("arena", { ...c, working_dir: "/wt", branch: "b" }, { task: "fix y", baseSha: "abc1234" });
    expect(text).toMatch(/只做任务要求的改动/);
    expect(text).not.toMatch(/只修/);
    expect(text).toContain("abc1234");
  });
});

describe("arena collect", () => {
  mkdirSync("_tmp/test-runs", { recursive: true });
  const dir = mkdtempSync(resolve("_tmp/test-runs/polish-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it("counts committed work only and lists untracked helpers apart without staging them", async () => {
    const wt = join(dir, "wt");
    mkdirSync(wt);
    const g = (...a: string[]) => execFileSync("git", a, { cwd: wt, stdio: "pipe" }).toString();
    g("init", "-q", "-b", "main");
    g("-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");
    const base = g("rev-parse", "HEAD").trim();
    writeFileSync(join(wt, "a.ts"), "export const a = 1;\n");
    g("add", "a.ts");
    g("-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "-m", "candidate");
    symlinkSync(dir, join(wt, "node_modules"));
    const out: any = await dispatch("fanout/collect", { repo_dir: wt, lanes: [{ label: "c1", working_dir: wt }], base_ref: base });
    expect(out.error).toBeUndefined();
    const row = out.result[0];
    expect(row.stat).toContain("a.ts");
    expect(row.stat).not.toContain("node_modules");
    expect(row.untracked).toEqual(["node_modules"]);
    expect(g("status", "--porcelain")).toBe("?? node_modules\n");
  });
});

// Findings from the final review (Codex/reviews/2026-10-04-keel-final-review.md).
describe("ready verdict needs all of CI, not just required checks", async () => {
  const { readyVerdict } = await import("../../src/node/pr/actions.ts");
  const gateOk = { applies: true, required: ["build"], passed: ["build"], failing: [], pending: [], missing: [], ok: true, sources: [] };
  it("blocks when an optional check fails although required ones are green", () => {
    const v = readyVerdict({ gate: gateOk, decision: { kind: "blocker", blocker: "failing-checks" }, checks: { failed: ["optional-ci"], pending: [], passed: 1 } } as any);
    expect(v.passed).toBe(false);
    expect(v.missing.join()).toContain("optional-ci");
  });
  it("blocks while any check is still running or threads are open", () => {
    expect(readyVerdict({ gate: gateOk, decision: { kind: "blocker", blocker: "draft-pr" }, checks: { failed: [], pending: ["e2e"], passed: 1 } } as any).passed).toBe(false);
    expect(readyVerdict({ gate: gateOk, decision: { kind: "blocker", blocker: "review-threads" }, checks: { failed: [], pending: [], passed: 1 } } as any).passed).toBe(false);
  });
  it("passes a green Draft", () => {
    expect(readyVerdict({ gate: gateOk, decision: { kind: "blocker", blocker: "draft-pr" }, checks: { failed: [], pending: [], passed: 2 } } as any)).toEqual({ passed: true, missing: [] });
  });
});

describe("two-stage dispatch", () => {
  const t = tiersFrom(routing as any, "claude-code");
  it("holds the cross-judge back and gives it the candidate worktrees and rubric", async () => {
    const { createWorkersPayload } = await import("../../src/main/fanout/spec.ts");
    const lanes = planLanes("arena", t, {}).map((l) => (l.write ? { ...l, working_dir: `/wt/${l.label}`, branch: `pstack/x/${l.label}` } : { ...l, working_dir: "/repo", branch: null }));
    const p = createWorkersPayload("fo-2601010000-abc", "arena", lanes, { task: "t", rubric: "最小改动", baseSha: "b0" });
    expect(p.workers.map((w) => w.label)).not.toContain("0000-abc-judge");
    const judge = p.after_stage1!.workers[0]!.initial_task;
    expect(judge).toContain("最小改动");
    for (const c of ["c1", "c2", "c3"]) expect(judge).toContain(`/wt/${c}`);
  });
});

describe("worktree audit", async () => {
  const { bucketOf } = await import("../../src/node/git/worktree.ts");
  const row = { path: "/w", branch: "b", ageDays: 9, merged: false, porcelain: "", remote: "pushed", prState: "MERGED", prNumber: 1, recentDays: 9 };
  it("a reused branch name does not inherit an old MERGED PR", () => {
    expect(bucketOf({ ...row, prHeadMatches: false })).toBe("review");
    expect(bucketOf({ ...row, prHeadMatches: true })).toBe("safe");
  });
  it("unpushed commits keep a worktree out of safe", () => {
    expect(bucketOf({ ...row, prHeadMatches: true, remote: "ahead1" })).toBe("review");
  });
});

describe("review scene and lane rules in fanout/prepare", () => {
  mkdirSync("_tmp/test-runs", { recursive: true });
  const dir = mkdtempSync(resolve("_tmp/test-runs/scene-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const routingPath = join(dir, "routing.json");
  writeFileSync(routingPath, JSON.stringify(routing));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe" }).toString();
  g(repo, "init", "-q", "-b", "main");
  g(repo, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");
  const feature = join(repo, ".worktrees", "feat");
  g(repo, "worktree", "add", "-q", "-b", "feat", feature);
  g(feature, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "feature work");
  const profile = { lanes: [{ repo: "acme/gated-app", preset: "draft-gated-handoff" as const }], routingPath, boardRepos: [], plansDir: null };
  it("reviewers stay in the feature worktree the caller is in", async () => {
    const out: any = await dispatch("fanout/prepare", { profile, fanout_id: "fo-scene-0001", kind: "interrogate", repo_dir: feature, base_ref: "main", lead_agent: "claude-code" });
    expect(out.error).toBeUndefined();
    for (const l of out.result.lanes) expect(l.working_dir).toBe(feature);
    expect(out.result.scene_head).toBe(g(feature, "rev-parse", "HEAD").trim());
    expect(out.result.base_sha).toBe(g(repo, "rev-parse", "main").trim());
  });
  it("refuses review without lead_agent instead of guessing", async () => {
    const out: any = await dispatch("fanout/prepare", { profile, fanout_id: "fo-scene-0002", kind: "interrogate", repo_dir: feature, base_ref: "main" });
    expect(out.error?.message).toMatch(/lead_agent/);
  });
  it("a lane with local review off refuses interrogate unless the user asked", async () => {
    g(repo, "remote", "add", "origin", "https://github.com/acme/gated-app.git");
    const out: any = await dispatch("fanout/prepare", { profile, fanout_id: "fo-scene-0003", kind: "interrogate", repo_dir: feature, base_ref: "main", lead_agent: "claude-code" });
    expect(out.error?.message).toMatch(/^LANE_RULE/);
    const ok: any = await dispatch("fanout/prepare", { profile, fanout_id: "fo-scene-0004", kind: "interrogate", repo_dir: feature, base_ref: "main", lead_agent: "claude-code", user_requested: true });
    expect(ok.error).toBeUndefined();
  });
});
