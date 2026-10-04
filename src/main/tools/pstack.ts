// pstack_start / pstack_decide / pstack_ledger: the workflow entry, explicit judgements,
// and the run ledger. Routing falls back to deterministic rules when Jev is unavailable.

import { KeelError } from "../host.ts";
import { node, requireString, type ToolContext } from "../context.ts";
import { PLAYBOOKS, template, type TemplateId } from "../jev/templates.ts";
import { judge } from "../judge.ts";
import { append, newRunId, read, type LedgerKind } from "../ledger.ts";
import { resolveLane } from "../../shared/lanes.ts";

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

export async function pstackStart(ctx: ToolContext, args: Record<string, unknown>) {
  const task = requireString(args, "task");
  const runId = newRunId(ctx.host.now());
  const named = typeof args.playbook === "string" ? args.playbook : null;
  if (named && ![...PLAYBOOKS, "figure-it-out"].includes(named as any)) throw new KeelError("INVALID_INPUT", `未知 playbook ${named}。可选：${PLAYBOOKS.join("、")}、figure-it-out。`);
  const state = { task, ...(typeof args.context === "string" ? { context: args.context } : {}) };
  const specs: { id: TemplateId; state: Record<string, unknown> }[] = named ? [{ id: "J2", state }] : [{ id: "J1", state }, { id: "J2", state }];
  const outcome = await judge(ctx, specs, { runId });
  const j1 = outcome.judgements.find((j) => j.template === "J1");
  const j2 = outcome.judgements.find((j) => j.template === "J2");
  let playbook = named ?? "";
  let routeSource = named ? "user" : "jev";
  if (!named) {
    if (j1?.policy.action === "act") playbook = String(j1.policy.value);
    else {
      playbook = keywordRoute(task);
      routeSource = j1?.interpretation ? "keyword (jev below threshold)" : "keyword (jev unavailable)";
    }
  }
  const depth = j2?.policy.action === "act" ? Number(j2.policy.value) : null;
  let lane = null;
  if (typeof args.repo_dir === "string") {
    try {
      const st = await node(ctx, "git/state", { repo_dir: args.repo_dir });
      lane = { git: st };
    } catch {
      lane = null;
    }
  }
  if (typeof args.repo === "string") lane = { ...(lane ?? {}), preset: resolveLane(ctx.profile, args.repo).rule.preset };
  const info = PLAYBOOK_INFO[playbook];
  const multi = MULTI_PR.has(playbook);
  const next = playbook === "trivial_no_pstack"
    ? "不需要 pstack 流程，直接回答或做这处小改动。"
    : multi
      ? "这是跨多个 PR 的任务：按用户既定流程交给 task-priority → approve-exec（需要用户说“汇总任务优先级”再“批准执行”）。Keel 不另起编排；先把任务目标、仓库与验收标准整理给用户。"
      : `用 ghost_manual({ ghost_id: "keel", path: "${manualPath(playbook)}" }) 读取 playbook，按步骤执行；关键判断点用 pstack_decide，留痕用 pstack_ledger。`;
  await append(ctx.host, { run_id: runId, kind: "step", summary: `start ${playbook}（${routeSource}）depth=${depth ?? "?"}` });
  return {
    run_id: runId,
    playbook,
    route_source: routeSource,
    manual_path: manualPath(playbook),
    steps: info?.steps ?? [],
    depth,
    suggest: { architect: depth !== null && depth >= 2, arena: depth !== null && depth >= 3, interrogate: false, multi_pr_pipeline: multi },
    lane,
    jev: outcome.answers ? outcome.judgements.map((j) => ({ template: j.template, value: j.interpretation?.value ?? null, confidence: j.interpretation?.confidence ?? 0, policy: j.policy.action, ranked: j.interpretation?.ranked?.slice(0, 2) })) : null,
    ...(outcome.fallback_reason ? { fallback_reason: outcome.fallback_reason } : {}),
    next,
  };
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
