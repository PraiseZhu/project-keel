import { describe, expect, it } from "vitest";
import { BRIEF_FORBIDDEN, buildBrief, REVISE_TASK } from "../../src/main/graph/brief.ts";

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

function expectUnifiedP2P3(task: string): void {
  expect(task).toContain("本 PR 引入或改动范围内已证实的真实问题");
  expect(task).toContain("误导性测试");
  expect(task).toContain("PR 自己写明的验收没达成");
  expect(task).toContain("声称做过的验证实际没做");
  expect(task).toContain("单纯缺测试或违反通用规范不单独构成 P2");
  expect(task).toContain("生产行为已正确且 PR 未声称覆盖的补测试或覆盖率建议");
  expect(task).toContain("不影响结论的措辞");
  expect(task).not.toContain("规范违反或测试缺口");
}

describe("buildBrief", () => {
  it("tells non-writing nodes they are read-only instead of listing writable files (real run ⑫)", () => {
    const text = buildBrief({ ...node, id: "explore", writes: false }, run, ctx);
    expect(text).toContain("只读：不得修改任何文件");
    expect(text).not.toContain("可写：");
    expect(buildBrief(node, run, ctx)).toContain("可写：src/login.ts");
  });

  it("asks every report kind for sc_evidence so the done gate can see SC evidence (real run ⑩)", () => {
    const kinds = [
      buildBrief(node, run, ctx),
      buildBrief({ ...node, id: "explore", writes: false, inline_report: true }, run, ctx),
      buildBrief({ ...node, id: "research", writes: false, plugin_task: true }, run, ctx),
    ];
    for (const text of kinds) {
      expect(text).toContain("sc_evidence");
      expect(text).toContain("ACCEPTANCE 每条都要写");
    }
  });

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
    expect(text).toContain("测试运行器本身的命令");
    expect(text).toContain("npm run verify");
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
    expect(text).toContain("最后一条回复必须只包含一个");
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

  it("lists completed .keel reports whenever priorReports is set, including attempt 1", () => {
    const reports = [
      "/repo/.worktrees/keel-run-1/.keel/astra-final-review-1.md",
      "/repo/.worktrees/keel-run-1/.keel/implement-1.md",
    ];
    const retry = buildBrief(node, run, { ...ctx, priorReports: reports });
    expect(retry).toContain("先读这些已完成报告再动手");
    expect(retry).toContain(reports[0]);
    expect(retry).toContain(reports[1]);
    const first = buildBrief(node, run, { ...ctx, attempt: 1, dispatch_key: "run-1:implement:1", priorReports: reports });
    expect(first).toContain("先读这些已完成报告再动手");
    expect(first).toContain(reports[0]);
    const plain = buildBrief(node, run, { ...ctx, attempt: 1, dispatch_key: "run-1:implement:1" });
    expect(plain).not.toContain("先读这些已完成报告再动手");
  });
});

describe("node task line", () => {
  const base = { run_id: "run-1", goal: "修好登录空指针", worktree: "/w" };
  const ctx1 = { attempt: 1, dispatch_key: "run-1:x:1" };

  it("bug-fix writer does failing test, root cause, minimal fix, tests in one session", () => {
    const text = buildBrief({ id: "implement", role: "worker", writes: true }, { ...base, taskType: "bug-fix" }, ctx1);
    const task = text.split("\n").find((l) => l.startsWith("TASK"))!;
    expect(task).toContain("失败的测试");
    expect(task).toContain("单独提交");
    expect(task).toContain("根因");
    expect(task).toContain("最小修复");
    expect(text.indexOf("TASK")).toBeGreaterThan(text.indexOf("GOAL"));
    expect(text.indexOf("TASK")).toBeLessThan(text.indexOf("SCOPE"));
  });

  it("feature writer follows the plan; refactoring writer pins behavior first", () => {
    const feature = buildBrief({ id: "implement", role: "worker", writes: true }, { ...base, taskType: "feature" }, ctx1);
    expect(feature).toContain("方案报告");
    const refactor = buildBrief({ id: "implement", role: "worker", writes: true }, { ...base, taskType: "refactoring" }, ctx1);
    expect(refactor).toContain("钉住现有行为的测试");
  });

  it("the review is read-only, runs tests, and maps confirmed P0/P1/P2 to FAIL", () => {
    const text = buildBrief({ id: "astra-final-review", role: "verifier", writes: false }, { ...base, taskType: "bug-fix" }, ctx1);
    const task = text.split("\n").find((l) => l.startsWith("TASK"))!;
    expect(text).toContain("非作者审查者");
    expect(task).toContain("P0/P1/P2");
    expect(task).toContain("有确认成立的 P0/P1/P2 或 SC 不通过时 verdict 写 FAIL");
    expect(task).toContain("只有 P3");
    expectUnifiedP2P3(task);
    expect(text).toContain("测试运行器本身的命令");
    expect(text).toContain("先于修复（fix:）提交");
    expect(text).toContain("只读：不得修改任何文件");
  });

  it("the bug-fix review reruns the pre-fix test only in a temporary worktree", () => {
    const text = buildBrief({ id: "astra-final-review", role: "verifier", writes: false }, { ...base, taskType: "bug-fix" }, ctx1);
    const task = text.split("\n").find((l) => l.startsWith("TASK"))!;
    expect(task).toContain("git worktree add");
    expect(task).toContain("不要在当前工作树 checkout、reset、stash 或改文件");
  });

  it("a returned writer gets the revise task whichever node it is; read-only nodes keep their own", () => {
    for (const id of ["implement", "fix-ci"]) {
      const text = buildBrief({ id, role: "worker", writes: true }, { ...base, taskType: "bug-fix" }, { ...ctx1, returned: true });
      const task = text.split("\n").find((l) => l.startsWith("TASK"))!;
      expect(task).toContain(REVISE_TASK);
      expect(task).toContain("P0/P1/P2");
      expect(task).toContain("P3 记录不修");
      expect(task).not.toContain("PR 的 CI 失败了");
      expect(task).not.toContain("写一个在当前代码上失败的测试");
    }
    const review = buildBrief({ id: "astra-final-review", role: "verifier", writes: false }, { ...base, taskType: "bug-fix" }, { ...ctx1, returned: true });
    expect(review).toContain("非作者审查者");
    expect(review).not.toContain(REVISE_TASK);
  });

  it("triage-threads only fixes confirmed P0/P1/P2 and records P3", () => {
    const text = buildBrief({ id: "triage-threads", role: "worker", writes: true }, { ...base, taskType: "bug-fix" }, ctx1);
    const task = text.split("\n").find((l) => l.startsWith("TASK"))!;
    expect(task).toContain("只修确认成立的 P0/P1/P2");
    expect(task).toContain("P3/不成立不改代码");
    expect(task).toContain("证据不足先待核实");
    expectUnifiedP2P3(task);
  });

  it("falls back to the repo's own test command when no SC has verify", () => {
    const text = buildBrief({ id: "implement", role: "worker", writes: true }, { ...base, taskType: "bug-fix" }, ctx1);
    expect(text).toMatch(/VERIFY\s+没有指定时用仓库自带的测试命令/);
  });
});

describe("VERIFY line", () => {
  it("lists a shared verify command once", () => {
    const text = buildBrief(
      { id: "implement", role: "worker", writes: true },
      { run_id: "run-1", goal: "g", worktree: "/w", taskType: "bug-fix", sc: [{ id: "SC-1", text: "a", verify: "npm test" }, { id: "SC-2", text: "b", verify: "npm test" }] },
      { attempt: 1, dispatch_key: "run-1:implement:1" },
    );
    expect(text).toMatch(/^VERIFY\s+npm test$/m);
  });
});
