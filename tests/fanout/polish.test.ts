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
    const text = promptFor("interrogate", r!, "review x", "rubric");
    expect(text).toContain("只读");
    expect(text).not.toMatch(/只修/);
  });
  it("write candidates keep the P0/P1 fix rule", () => {
    const c = planLanes("arena", t, {}).find((l) => l.write)!;
    expect(promptFor("arena", { ...c, working_dir: "/wt", branch: "b" }, "fix y")).toMatch(/只修确认成立的 P0\/P1/);
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
