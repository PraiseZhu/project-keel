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
}

function isInvestigation(node: BriefNode, run: BriefRun): boolean {
  return node.inline_report === true || run.taskType === "investigation";
}

function reportPath(node: BriefNode, run: BriefRun, ctx: BriefCtx): string {
  return `${run.worktree ?? "<worktree>"}/.keel/${node.id}-${ctx.attempt}.md`;
}

function pad(label: string, body: string): string {
  return `${label.padEnd(12)}${body}`;
}

export function buildBrief(node: BriefNode, run: BriefRun, ctx: BriefCtx): string {
  const investigation = isInvestigation(node, run);
  const allow = (ctx.scopeAllow ?? []).join("、") || "（未列出则不得写文件）";
  const deny = (ctx.scopeDeny ?? []).length ? `；不得改：${ctx.scopeDeny!.join("、")}` : "";
  const scope = investigation
    ? `只读。不建 worktree、不写源码。可读 ${run.repo ?? "repo_dir"}。`
    : `可写：${allow}${deny}。工作树：${run.worktree ?? "（无）"}。只改 SCOPE 内文件。${node.writes ? "改完后只 git add 你改过的 SCOPE 内文件并 commit（不要 add .keel/），没有改动就不提交；不要 push。报告里的 head_sha 写 commit 之后的 HEAD。" : ""}`;
  const acceptance = (run.sc ?? []).map((s) => `${s.id}: ${s.text}`).join("\n             ") || "（无单独 SC，以 GOAL 为准）";
  const verify = [...(ctx.verify ?? []), ...(run.sc ?? []).map((s) => s.verify).filter((x): x is string => Boolean(x))].join("；") || "按 GOAL 自行给出可复现命令";
  const forbidden = [...BRIEF_FORBIDDEN, ...(ctx.extraForbidden ?? [])].join("；");
  const report = node.plugin_task
    ? `完成后，你的最后一条回复必须只包含一个 \`\`\`json fence 的 NodeReport：dispatch_key（必须是 ${ctx.dispatch_key}）、status（只能是 done / partial / blocked / failed，做完且验收通过写 done）、summary、citation?、sc_evidence（{SC id: true/false}，ACCEPTANCE 每条都要写）、ran?（[{cmd, exit_code, tests_passed}]）、files_changed?。这条回复之后不要再发任何消息。不要写 .keel/ 文件，也不要调用 keel_report。`
    : investigation
    ? "用 keel_report({phase:\"final\", inline_report}) 内联交回完整报告。JSON 必须含本节点 dispatch_key、status（done|partial|blocked|failed）、summary、sc_evidence（{SC id: true/false}，ACCEPTANCE 每条都要写）。不要写 .keel/。给主控的回复不超过 20 行摘要。"
    : `把完整报告写到 \`${reportPath(node, run, ctx)}\`：先一个 \`\`\`json fence（NodeReport：dispatch_key、status（只能是 done / partial / blocked / failed，做完且验收通过写 done）、summary、branch?、head_sha?、files_changed、functions_touched、changed_lines、ran、sc_evidence、findings?、verdict?（只能是 PASS / PASS+NOTES / FAIL）、next_suggestions?），后面接正文。sc_evidence 写 {SC id: true/false}，ACCEPTANCE 每条都要写，true 只给你本次实际跑过验证并通过的 SC（缺了编排判不了完成）。functions_touched 写实际改到的函数名（缺了编排会按已跨函数处理）；changed_lines 写新增+删除行数（缺了不能跳过最终复核）。ran 每项写 {cmd, exit_code, tests_passed}，tests_passed 照抄测试运行器总结行里“通过”的用例数；只列举、看版本、看帮助、只编译时写 0。给主控的回复只有 ≤20 行摘要和这个路径。`;
  const standing = (run.standing ?? "").trim() || "（无）";
  const ctxLines = [
    `run ${run.run_id} / 节点 ${node.id} / attempt ${ctx.attempt} / dispatch_key ${ctx.dispatch_key}`,
    run.pr != null ? `PR ${run.repo ?? ""}#${run.pr}` : run.repo ? `仓 ${run.repo}` : "",
    ctx.context ?? "",
  ].filter(Boolean).join("。");
  return [
    pad("GOAL", run.goal.trim()),
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
