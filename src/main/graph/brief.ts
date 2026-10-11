// Worker initial_task text. Sections follow orchestrate.md; FORBIDDEN is fixed plus unit bans.

export const BRIEF_FORBIDDEN = ["禁止合并", "禁止 force-push", "禁止 rebase", "禁止写域外文件", "禁止调用 KEEL 的 keel_* 工具（由主控调用）"] as const;

export interface BriefNode {
  readonly id: string;
  readonly role?: "explorer" | "researcher" | "worker" | "verifier" | "architect";
  readonly writes?: boolean;
  readonly timebox_min?: number;
  readonly inline_report?: boolean;
  /** Cindy plugin task (Researcher): KEEL reads its last assistant message, so it cannot write .keel/ or call keel_report. */
  readonly plugin_task?: boolean;
}

export interface BriefRun {
  readonly run_id: string;
  readonly goal: string;
  readonly sc?: readonly { readonly id: string; readonly text: string; readonly verify?: string }[];
  readonly worktree?: string | null;
  readonly repo?: string;
  readonly pr?: number | string;
  readonly standing?: string;
  readonly taskType?: string;
}

export interface BriefCtx {
  readonly attempt: number;
  readonly dispatch_key: string;
  readonly scopeAllow?: readonly string[];
  readonly scopeDeny?: readonly string[];
  readonly context?: string;
  readonly extraForbidden?: readonly string[];
  readonly verify?: readonly string[];
  /** Completed-node .keel/ report paths for retry / revise dispatches. */
  readonly priorReports?: readonly string[];
  /** The review or the done gate sent this writer back: TASK becomes the revise task. */
  readonly returned?: boolean;
}

/** Writer TASK after a FAIL review or a done-gate revise, whichever writer node the graph returns to. */
export const REVISE_TASK = "这是退回修改：先读 CONTEXT 里的报告（审查报告排在最前），只修其中确认成立的 P0/P1 和缺证据的 SC，已通过的部分不重做；要补测试就先补测试再改实现；改完跑相关测试和全量测试，然后提交。";

function isInvestigation(node: BriefNode, run: BriefRun): boolean {
  return node.inline_report === true || run.taskType === "investigation";
}

export function reportPath(node: BriefNode, run: BriefRun, ctx: BriefCtx): string {
  return `${run.worktree ?? "<worktree>"}/.keel/${node.id}-${ctx.attempt}.md`;
}

function pad(label: string, body: string): string {
  return `${label.padEnd(12)}${body}`;
}

/** What this node does and does not do. One line per node kind; the GOAL stays the user's words. */
export function nodeTask(node: BriefNode, run: BriefRun): string {
  const type = run.taskType ?? "bug-fix";
  switch (node.id) {
    case "implement":
      if (type === "feature") {
        return `你是写手。先读 CONTEXT 里的方案报告，按方案实现；新行为要有测试；分成小而有序的提交。`;
      }
      if (type === "refactoring") {
        return `你是写手。先写钉住现有行为的测试并单独提交；再小步重构，先删后加，每步保持测试通过；最后跑全部测试证明行为不变。不降低阅读负担的改动不要提交。`;
      }
      return `你是写手，一个会话做完：1) 写一个在当前代码上失败的测试（或可重复的复现脚本），跑一次确认它失败，单独提交（提交说明以 test: 开头）；2) 用运行时证据找根因，不凭猜测改；3) 只做证据支持的最小修复并提交（fix:）；4) 跑相关测试和全量测试，确认原来失败的测试现在通过。`;
    case "fix-ci":
      return "PR 的 CI 失败了：先看失败的检查和日志（gh pr checks、gh run view --log-failed），找到根因，只修让 CI 失败的问题并提交。";
    case "triage-threads":
      return "处理 PR 上未解决的评审线程：逐条核实；只修确认成立的 P0/P1 并提交；其余不改代码，在 findings 里写明分级和理由。";
    case "architect-plan":
      return "只读。先读相关代码，再写实现方案：改哪些文件和函数、数据结构、要加哪些测试、风险、明确不做的事。方案要具体到写手可以直接照做。";
    case "astra-final-review":
      return [
        "你是非作者审查者，只读，不改任何文件。",
        "1) 审 PR 的全部改动（gh pr diff，或 git diff <base>...HEAD），找确认成立的 P0/P1，每条写触发条件、错误行为、影响和证据（文件:行）；",
        "2) 对 ACCEPTANCE 每条亲自验证，sc_evidence 只给本次验证通过的；",
        "3) 跑测试，ran 里要有测试运行器本身的命令；",
        type === "bug-fix"
          ? "4) 用 git log 确认失败测试（test:）先于修复（fix:）提交；要复跑修复前的测试，只能用 git worktree add 检出到系统临时目录里跑，跑完 git worktree remove，不要在当前工作树 checkout、reset、stash 或改文件；"
          : type === "refactoring"
            ? "4) 判断改动是否降低了阅读负担，没有就判 FAIL；"
            : "4) 设计有明显更简单的做法时写进 findings；",
        "有确认成立的 P0/P1 或 SC 不通过时 verdict 写 FAIL，否则写 PASS（只有 P2/P3 时写 PASS+NOTES）。head_sha 写你审查的提交。",
      ].join("");
    case "astra-unstick":
      return "只读。同一失败已经重复出现：读 CONTEXT 里的报告，找出前几次为什么失败，给出根因和写手下一步的具体做法，写进 next_suggestions。";
    case "explore":
      return "只读调查：找到与 GOAL 相关的代码位置和调用关系，结论附文件:行引用。";
    case "research":
      return "只读核对：查资料、接口和历史改动，补全 explore 没有回答的问题，结论附出处。";
    default:
      return node.writes ? "按 GOAL 完成本节点并提交。" : "只读：按 GOAL 完成本节点，结论附出处。";
  }
}

export function buildBrief(node: BriefNode, run: BriefRun, ctx: BriefCtx): string {
  const investigation = isInvestigation(node, run);
  const allow = (ctx.scopeAllow ?? []).join("、") || "（未列出则不得写文件）";
  const deny = (ctx.scopeDeny ?? []).length ? `；不得改：${ctx.scopeDeny!.join("、")}` : "";
  const scope = investigation
    ? `只读。不建 worktree、不写源码。可读 ${run.repo ?? "repo_dir"}。`
    : !node.writes
    ? `只读：不得修改任何文件（只写下面 REPORT 指定的 .keel/ 报告）；发现要改的写进 findings / next_suggestions，交给写代码节点。工作树：${run.worktree ?? "（无）"}。`
    : `可写：${allow}${deny}。工作树：${run.worktree ?? "（无）"}。只改 SCOPE 内文件。${node.writes ? "改完后只 git add 你改过的 SCOPE 内文件并 commit（不要 add .keel/），没有改动就不提交；不要 push。报告里的 head_sha 写 commit 之后的 HEAD。" : ""}`;
  const acceptance = (run.sc ?? []).map((s) => `${s.id}: ${s.text}`).join("\n             ") || "（无单独 SC，以 GOAL 为准）";
  const verify = [...new Set([...(ctx.verify ?? []), ...(run.sc ?? []).map((s) => s.verify).filter((x): x is string => Boolean(x))])].join("；")
    || "没有指定时用仓库自带的测试命令（如 package.json 的 test 脚本、pytest、go test ./...），实际跑的命令写进 ran";
  const forbidden = [...BRIEF_FORBIDDEN, ...(ctx.extraForbidden ?? [])].join("；");
  const report = node.plugin_task
    ? `完成后，你的最后一条回复必须只包含一个 \`\`\`json fence 的 NodeReport：dispatch_key（必须是 ${ctx.dispatch_key}）、status（只能是 done / partial / blocked / failed，做完且验收通过写 done）、summary、citation?、sc_evidence（{SC id: true/false}，ACCEPTANCE 每条都要写）、ran?（[{cmd, exit_code, tests_passed}]）、files_changed?。这条回复之后不要再发任何消息。不要写 .keel/ 文件，也不要调用 keel_report。`
    : investigation
    ? `你的最后一条回复必须只包含一个 \`\`\`json fence 的完整 NodeReport：dispatch_key（必须是 ${ctx.dispatch_key}）、status（done|partial|blocked|failed）、summary、citation?、sc_evidence（{SC id: true/false}，ACCEPTANCE 每条都要写）、ran?、files_changed?。主控会把它原样交给 KEEL；你不要调用 keel_*，也不要写 .keel/。`
    : `把完整报告写到 \`${reportPath(node, run, ctx)}\`：先一个 \`\`\`json fence（NodeReport：dispatch_key、status（只能是 done / partial / blocked / failed，做完且验收通过写 done）、summary、branch?、head_sha?、files_changed、functions_touched、changed_lines、ran、sc_evidence、findings?、verdict?（只能是 PASS / PASS+NOTES / FAIL）、next_suggestions?），后面接正文。sc_evidence 写 {SC id: true/false}，ACCEPTANCE 每条都要写，true 只给你本次实际跑过验证并通过的 SC。functions_touched 写实际改到的函数名；changed_lines 写新增+删除行数。ran 每项写 {cmd, exit_code, tests_passed}，tests_passed 照抄测试运行器总结行里“通过”的用例数；ran 里要列测试运行器本身的命令（如 npm test、npx vitest run、pytest），npm run verify 这类聚合脚本不算测试命令；只列举、看版本、看帮助、只编译时写 0。给主控的回复只有 ≤20 行摘要和这个路径。`;
  const standing = (run.standing ?? "").trim() || "（无）";
  const prior =
    ctx.priorReports?.length
      ? `先读这些已完成报告再动手：${ctx.priorReports.join("；")}`
      : "";
  const ctxLines = [
    `run ${run.run_id} / 节点 ${node.id} / attempt ${ctx.attempt} / dispatch_key ${ctx.dispatch_key}`,
    run.pr != null ? `PR ${run.repo ?? ""}#${run.pr}` : run.repo ? `仓 ${run.repo}` : "",
    ctx.context ?? "",
    prior,
  ].filter(Boolean).join("。");
  return [
    pad("GOAL", run.goal.trim()),
    pad("TASK", ctx.returned && node.writes ? REVISE_TASK : nodeTask(node, run)),
    pad("SCOPE", scope),
    pad("CONTEXT", ctxLines),
    pad("ACCEPTANCE", acceptance),
    pad("VERIFY", verify),
    pad("TIMEBOX", `${node.timebox_min ?? 30} 分钟；到期交部分发现并停止，不要继续改`),
    pad("FORBIDDEN", forbidden),
    pad("REPORT", report),
    pad("STANDING", standing),
  ].join("\n");
}
