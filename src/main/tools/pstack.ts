// pstack_start is a migration wrapper over keel_run. pstack_decide stays (op log / read replaces pstack_ledger).

import { KeelError } from "../host.ts";
import { requireString, type ToolContext } from "../context.ts";
import { template, type TemplateId } from "../jev/templates.ts";
import { judge } from "../judge.ts";
import { append, read, type LedgerKind } from "../ledger.ts";

export interface PlaybookInfo {
  readonly summary: string;
  readonly steps: readonly string[];
}
declare const __KEEL_PLAYBOOKS__: Record<string, PlaybookInfo> | undefined;
export const PLAYBOOK_INFO: Record<string, PlaybookInfo> = typeof __KEEL_PLAYBOOKS__ !== "undefined" ? __KEEL_PLAYBOOKS__ : {};

/** Playbooks that span several PRs: the user routes those through the existing pipeline. */
export const MULTI_PR = new Set(["orchestrate", "autopilot-full", "autopilot-stack", "multi-phase-plan"]);

export function manualPath(playbook: string): string {
  if (playbook === "figure-it-out") return "pstack/skills/figure-it-out/SKILL.md";
  if (playbook === "trivial_no_pstack") return "keel/MANUAL.md";
  return `pstack/skills/poteto-mode/playbooks/${playbook}.md`;
}

/** Deterministic fallback router used when Jev is unavailable or below threshold. */
export function keywordRoute(task: string): string {
  const t = task.toLowerCase();
  const rules: [RegExp, string][] = [
    [/盯|babysit|watch.*pr|ci.*(红|绿)|review comment|评审意见/, "babysit"],
    [/开 ?pr|open.*pr|提 ?pr|发 ?pr/, "opening-a-pr"],
    [/worktree|工作树.*(清|删)/, "worktree-cleanup"],
    [/接手|pick ?up|续上|恢复现场/, "session-pickup"],
    [/暂停|pause|收尾保存/, "pause-safely"],
    [/重构|refactor/, "refactoring"],
    [/性能|perf|慢|卡顿/, "perf-issue"],
    [/原型|prototype|spike/, "prototype"],
    [/bug|修复|报错|崩溃|fix|异常|失败/, "bug-fix"],
    [/怎么|如何|why|how|为什么|调查|investigat|原理/, "investigation"],
    [/新增|功能|feature|实现|支持/, "feature"],
  ];
  for (const [re, pb] of rules) if (re.test(t)) return pb;
  return "figure-it-out";
}

/** The user named a multi-model mode outright; Jev confidence must not hide that. */
export function explicitFanout(task: string): { interrogate: boolean; arena: boolean } {
  const t = task.toLowerCase();
  return {
    interrogate: /interrogate|交叉审查|(多|[两三四2-4])个?(不同)?模型.{0,4}(审|review)/.test(t),
    arena: /arena|(多|[两三四2-4])个?候选|多方案/.test(t),
  };
}

const LEADS = new Set(["codex", "claude-code", "pi"]);

export async function pstackStart(ctx: ToolContext, args: Record<string, unknown>) {
  if (typeof args.repo_dir !== "string" || !args.repo_dir.trim()) {
    throw new KeelError("INVALID_INPUT", "迁移入口 pstack_start 需要 repo_dir。请改用 keel_run({ goal, sc, repo_dir, lead })。");
  }
  const lead = typeof args.lead === "string" ? args.lead : undefined;
  if (!lead || !LEADS.has(lead)) {
    throw new KeelError("INVALID_INPUT", "迁移入口 pstack_start 需要合法 lead（codex / claude-code / pi）。请改用 keel_run({ goal, sc, repo_dir, lead })。");
  }
  const { keelRun } = await import("./keel.ts");
  return keelRun(ctx, { ...args, goal: typeof args.goal === "string" ? args.goal : requireString(args, "task"), lead });
}

/** pstack_decide tool: op "decide" (default) asks Jev; "log" / "read" are the former pstack_ledger. */
export async function pstackDecideTool(ctx: ToolContext, args: Record<string, unknown>) {
  const op = args.op === undefined ? "decide" : args.op;
  if (op === "decide") return pstackDecide(ctx, args);
  if (op === "log" || op === "read") return pstackLedger(ctx, { ...args, op });
  throw new KeelError("INVALID_INPUT", `pstack_decide 的 op 只能是 decide / log / read，收到 ${JSON.stringify(op)}。`);
}

export async function pstackDecide(ctx: ToolContext, args: Record<string, unknown>) {
  const id = requireString(args, "template") as TemplateId;
  if (!template(id)) throw new KeelError("INVALID_INPUT", `template 须为 J1–J12；通用问答请用 jev 工具。`);
  const state = args.state && typeof args.state === "object" ? (args.state as Record<string, unknown>) : { text: args.state };
  const options = Array.isArray(args.options) ? (args.options as string[]) : undefined;
  const runId = typeof args.run_id === "string" ? args.run_id : undefined;
  const outcome = await judge(ctx, [{ id, state, ...(options ? { options } : {}) }], { ...(runId ? { runId } : {}), reasked: args.reasked === true });
  const j = outcome.judgements[0]!;
  if (!outcome.answers && outcome.error_code && j.policy.action !== "minimal" && j.policy.action !== "stop") throw new KeelError(outcome.error_code, outcome.fallback_reason ?? "Jev 调用失败。");
  return { answers: outcome.answers, interpretation: j.interpretation, policy: j.policy, ledger_row: j.ledger_row ?? null, ...(outcome.fallback_reason ? { fallback_reason: outcome.fallback_reason } : {}) };
}

export async function pstackLedger(ctx: ToolContext, args: Record<string, unknown>) {
  const op = requireString(args, "op");
  if (op === "read") return { rows: await read(ctx.host, typeof args.run_id === "string" ? args.run_id : undefined, typeof args.limit === "number" ? args.limit : 50) };
  if (op !== "log") throw new KeelError("INVALID_INPUT", "op 只能是 log 或 read。");
  const runId = requireString(args, "run_id");
  const kind = requireString(args, "kind") as LedgerKind;
  if (!["decision", "step", "evidence", "gap"].includes(kind)) throw new KeelError("INVALID_INPUT", "kind 只能是 decision、step、evidence、gap。");
  await read(ctx.host, runId, 1);
  const row = await append(ctx.host, { run_id: runId, kind, summary: requireString(args, "summary"), ...(args.evidence !== undefined ? { evidence: args.evidence } : {}) });
  return { row_id: row.row_id };
}
