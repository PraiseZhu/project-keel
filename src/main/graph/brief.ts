// Worker initial_task text. Sections follow orchestrate.md; FORBIDDEN is fixed plus unit bans.

export const BRIEF_FORBIDDEN = ["禁止合并", "禁止 force-push", "禁止 rebase", "禁止写域外文件"] as const;

export interface BriefNode {
  readonly id: string;
  readonly role?: "explorer" | "researcher" | "worker" | "verifier" | "architect";
  readonly writes?: boolean;
  readonly timebox_min?: number;
  readonly inline_report?: boolean;
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
    : `可写：${allow}${deny}。工作树：${run.worktree ?? "（无）"}。只改 SCOPE 内文件。`;
  const acceptance = (run.sc ?? []).map((s) => `${s.id}: ${s.text}`).join("\n             ") || "（无单独 SC，以 GOAL 为准）";
  const verify = [...(ctx.verify ?? []), ...(run.sc ?? []).map((s) => s.verify).filter((x): x is string => Boolean(x))].join("；") || "按 GOAL 自行给出可复现命令";
  const forbidden = [...BRIEF_FORBIDDEN, ...(ctx.extraForbidden ?? [])].join("；");
  const report = investigation
    ? "用 keel_report({phase:\"final\", inline_report}) 内联交回完整报告。不要写 .keel/。给主控的回复不超过 20 行摘要。"
    : `把完整报告写到 \`${reportPath(node, run, ctx)}\`：先一个 \`\`\`json fence（NodeReport：dispatch_key、status、summary、branch?、head_sha?、files_changed、ran、findings?、verdict?、next_suggestions?），后面接正文。给主控的回复只有 ≤20 行摘要和这个路径。`;
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
