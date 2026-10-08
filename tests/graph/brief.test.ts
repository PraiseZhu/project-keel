import { describe, expect, it } from "vitest";
import { BRIEF_FORBIDDEN, buildBrief } from "../../src/main/graph/brief.ts";

const node = { id: "implement", role: "worker" as const, writes: true, timebox_min: 45 };
const run = {
  run_id: "run-1",
  goal: "修好登录空指针",
  sc: [{ id: "SC-1", text: "复现用例转绿", verify: "npx vitest run tests/login.test.ts" }],
  worktree: "/repo/.worktrees/keel-run-1",
  repo: "acme/app",
  pr: 12,
  standing: "不合并。",
  taskType: "bug-fix" as const,
};
const ctx = {
  attempt: 2,
  dispatch_key: "run-1:implement:2",
  scopeAllow: ["src/login.ts", "tests/**"],
  context: "见 issue #4",
  extraForbidden: ["禁止改配置"],
};

describe("buildBrief", () => {
  it("emits orchestrate sections with the fixed FORBIDDEN list and .keel report path", () => {
    const text = buildBrief(node, run, ctx);
    for (const label of ["GOAL", "SCOPE", "CONTEXT", "ACCEPTANCE", "VERIFY", "TIMEBOX", "FORBIDDEN", "REPORT", "STANDING"]) {
      expect(text).toContain(label);
    }
    for (const ban of BRIEF_FORBIDDEN) expect(text).toContain(ban);
    expect(text).toContain("禁止改配置");
    expect(text).toContain("/repo/.worktrees/keel-run-1/.keel/implement-2.md");
    expect(text).toContain("≤20 行摘要");
    expect(text).toContain("functions_touched");
    expect(text).toContain("changed_lines");
    expect(text).toContain("dispatch_key run-1:implement:2");
    expect(text).toMatchSnapshot();
  });

  it("investigation briefs are read-only and inline, with no .keel path", () => {
    const text = buildBrief(
      { id: "report", role: "researcher", writes: false, inline_report: true, timebox_min: 20 },
      { ...run, taskType: "investigation", worktree: null },
      { ...ctx, attempt: 1, dispatch_key: "run-1:report:1" },
    );
    expect(text).toContain("只读");
    expect(text).toContain("inline_report");
    expect(text).not.toMatch(/\.keel\/[a-z0-9]/);
    expect(text).toContain("不要写 .keel/");
    expect(text).toContain("禁止合并");
    expect(text).toMatchSnapshot();
  });
});

describe("plugin task brief", () => {
  it("asks for the NodeReport as the last reply, not a .keel/ file", () => {
    const text = buildBrief(
      { id: "research", role: "researcher", plugin_task: true },
      { run_id: "run-1", goal: "g", worktree: "/repo/.worktrees/keel-run-1", taskType: "bug-fix" },
      { attempt: 1, dispatch_key: "run-1:research:1" },
    );
    expect(text).toContain("最后一条回复必须只包含");
    expect(text).toContain("dispatch_key（必须是 run-1:research:1）");
    expect(text).not.toContain("/.keel/research-1.md");
  });
});

describe("writing node brief", () => {
  it("tells the worker to commit its scoped changes without pushing (real run: PR had no commits)", () => {
    const text = buildBrief({ id: "implement", role: "worker", writes: true }, { run_id: "run-1", goal: "g", worktree: "/repo/.worktrees/keel-run-1" }, { attempt: 1, dispatch_key: "run-1:implement:1", scopeAllow: ["src/**"] });
    expect(text).toContain("commit");
    expect(text).toContain("不要 push");
    expect(buildBrief({ id: "explore", role: "explorer" }, { run_id: "run-1", goal: "g", worktree: "/w" }, { attempt: 1, dispatch_key: "run-1:explore:1" })).not.toContain("并 commit");
  });
});
