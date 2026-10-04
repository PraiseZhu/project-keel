// PR lane tools. Policy (lanes.ts) decides which actions are allowed; Jev (J6/J8/J4/J5)
// only ranks inside that set. No tool here can merge: a ready PR is reported as
// mergeable with its link, and the user merges on GitHub.

import { allowedActions } from "../../shared/lanes.ts";
import type { PrAction, PrStatus } from "../../shared/types.ts";
import { KeelError } from "../host.ts";
import { node, requireString, type ToolContext } from "../context.ts";
import { assertNotHandedOff, readHandoff, writeHandoff } from "../handoff.ts";
import { judge } from "../judge.ts";
import { append } from "../ledger.ts";

type Snapshot = Omit<PrStatus, "handedOff" | "allowedActions" | "nextAction">;

function prArgs(args: Record<string, unknown>) {
  return {
    ...(typeof args.repo_dir === "string" ? { repo_dir: args.repo_dir } : {}),
    ...(typeof args.repo === "string" ? { repo: args.repo } : {}),
    ...(typeof args.pr === "number" ? { pr: args.pr } : typeof args.pr === "string" && /^\d+$/.test(args.pr) ? { pr: Number(args.pr) } : {}),
  };
}

export async function status(ctx: ToolContext, args: Record<string, unknown>, opts: { jev?: boolean } = {}): Promise<PrStatus & { jev?: unknown; merge_hint?: string }> {
  const snap = await node<Snapshot>(ctx, "pr/snapshot", prArgs(args));
  const handedOff = Boolean(await readHandoff(ctx.host, snap.pr.repo, snap.pr.number));
  const allowed = allowedActions({ rule: snap.rule, decision: snap.decision.kind, ...(snap.decision.blocker ? { blocker: snap.decision.blocker } : {}), isDraft: snap.pr.isDraft, gate: snap.gate, handedOff });
  let next: PrAction = allowed[0]!;
  let jev: unknown;
  if (opts.jev !== false) {
    const specs: Parameters<typeof judge>[1] = [];
    if (allowed.length > 1) specs.push({ id: "J8", state: { pr: snap.rendered, allowed_actions: allowed }, options: allowed });
    if (snap.decision.blocker === "failing-checks") specs.push({ id: "J6", state: { failed: snap.checks.failed, pr: snap.rendered } });
    if (specs.length) {
      const o = await judge(ctx, specs, typeof args.run_id === "string" ? { runId: args.run_id } : {});
      const j8 = o.judgements.find((j) => j.template === "J8");
      if (j8?.policy.action === "act" && allowed.includes(j8.policy.value as PrAction)) next = j8.policy.value as PrAction;
      jev = o.answers ? o.judgements.map((j) => ({ template: j.template, value: j.interpretation?.value, confidence: j.interpretation?.confidence, policy: j.policy.action })) : { unavailable: o.fallback_reason };
    }
  }
  const out = { ...snap, handedOff, allowedActions: allowed, nextAction: next, ...(jev !== undefined ? { jev } : {}) };
  return snap.decision.kind === "ready" ? { ...out, merge_hint: `可合并：请在 GitHub 打开 ${snap.pr.url} 自行合并。Keel 不提供合并。` } : out;
}

export async function prStatus(ctx: ToolContext, args: Record<string, unknown>) {
  try {
    return await status(ctx, args);
  } catch (e) {
    if (e instanceof KeelError && !["NO_PR", "GH_ERROR", "TOOL_NOT_FOUND", "INVALID_INPUT"].includes(e.code)) throw new KeelError("GH_ERROR", e.message);
    throw e;
  }
}

export async function prWait(ctx: ToolContext, args: Record<string, unknown>) {
  const until = args.until === "change" ? "change" : "ci_terminal";
  const maxMinutes = Math.min(25, Math.max(1, typeof args.max_minutes === "number" ? args.max_minutes : 20));
  const start = ctx.host.now();
  const deadline = start + maxMinutes * 60_000;
  let first: Awaited<ReturnType<typeof status>> | null = null;
  let last: Awaited<ReturnType<typeof status>> | null = null;
  const fingerprint = (s: NonNullable<typeof last>) => JSON.stringify([s.decision, s.checks, s.unresolvedThreads, s.pr.headSha, s.pr.isDraft]);
  for (;;) {
    last = await status(ctx, args, { jev: false });
    first ??= last;
    const terminal = last.decision.kind !== "waiting";
    if (until === "ci_terminal" ? terminal : fingerprint(last) !== fingerprint(first)) break;
    if (ctx.host.now() + 30_000 > deadline) {
      throw new KeelError("TIMEOUT", `等待 ${maxMinutes} 分钟仍未到终态：${last.rendered}`, { last });
    }
    // Sleep ≥30 s between polls, heart-beating so the host keeps the call alive.
    for (let waited = 0; waited < 30_000; waited += 15_000) {
      ctx.host.progress(ctx.callId);
      await ctx.host.sleep(15_000);
    }
  }
  const changed = first && last ? (["decision", "checks", "unresolvedThreads"] as const).filter((k) => JSON.stringify(first![k]) !== JSON.stringify(last![k])) : [];
  const final = await status(ctx, args);
  return { ...final, waited_seconds: Math.round((ctx.host.now() - start) / 1000), changed };
}

function requireAuth(args: Record<string, unknown>, what: string): string {
  const a = args.authorization_source;
  if (typeof a !== "string" || a.trim().length < 4)
    throw new KeelError("AUTHORIZATION_REQUIRED", `${what}需要 authorization_source：写明用户哪句话授权了这个动作（例如“用户 2026-10-04：提交 PR”）。没有授权就先问用户。`);
  return a.trim();
}

export async function prOpen(ctx: ToolContext, args: Record<string, unknown>) {
  const repoDir = requireString(args, "repo_dir");
  const title = requireString(args, "title");
  if (args.sections === undefined) throw new KeelError("INVALID_INPUT", "缺少 sections（PR 正文各段，对象或字符串）。");
  const auth = requireAuth(args, "开 PR");
  const r = await node(ctx, "pr/open", { repo_dir: repoDir, title, sections: args.sections, ...(typeof args.base === "string" ? { base: args.base } : {}), ...(typeof args.draft === "boolean" ? { draft: args.draft } : {}), push: args.push === true });
  if (typeof args.run_id === "string") await append(ctx.host, { run_id: args.run_id, kind: "step", summary: `pr_open ${r.url}（授权：${auth}）`, evidence: r });
  return { ...r, authorization_source: auth };
}

export async function prReady(ctx: ToolContext, args: Record<string, unknown>) {
  const dry = args.dry_run === true;
  const auth = dry ? null : requireAuth(args, "转 Ready ");
  const snapArgs = prArgs(args);
  const pre = await node<Snapshot>(ctx, "pr/snapshot", snapArgs);
  if (!dry) await assertNotHandedOff(ctx.host, pre.pr.repo, pre.pr.number);
  const handed = Boolean(await readHandoff(ctx.host, pre.pr.repo, pre.pr.number));
  const r = await node(ctx, "pr/ready", { ...snapArgs, repo: pre.pr.repo, pr: pre.pr.number, dry_run: dry });
  if (!r.gate.passed) throw new KeelError("GATE_NOT_MET", `Ready 门禁未满足：${r.gate.missing.join("、")}。`, { missing: r.gate.missing, gate: r.gate });
  let handoff = null;
  if (!dry && r.ready && pre.rule.postReadyOwner === "automation") {
    handoff = { repo: pre.pr.repo, number: pre.pr.number, at: new Date(ctx.host.now()).toISOString(), head_sha: r.head_sha, gate: r.gate, evidence: { state: pre.pr.state, url: pre.pr.url, labels: pre.pr.labels, authorization_source: auth } };
    await writeHandoff(ctx.host, handoff);
  }
  if (typeof args.run_id === "string") await append(ctx.host, { run_id: args.run_id, kind: "step", summary: `pr_ready ${dry ? "dry-run" : "执行"} ${pre.pr.repo}#${pre.pr.number} → ready=${r.ready}`, evidence: r.gate });
  return { ready: r.ready, executed: r.executed, dry_run: dry, gate: r.gate, handoff, handed_off: Boolean(handoff) || handed, ...(r.would_mark_ready !== undefined ? { would_mark_ready: r.would_mark_ready } : {}) };
}

export async function prThreads(ctx: ToolContext, args: Record<string, unknown>) {
  const t = await node<{ repo: string; number: number; threads: { id: string; author: string | null; path: string | null; line: number | null; body: string; is_bot: boolean }[] }>(ctx, "pr/threads", prArgs(args));
  if (!t.threads.length) return { ...t, triage: [], summary: "没有未解决的评审线程。" };
  const items = t.threads.map((x) => ({ id: x.id, author: x.author, path: x.path, line: x.line, body: x.body.slice(0, 1500) }));
  const bots = items.filter((_, i) => t.threads[i]!.is_bot);
  const specs: Parameters<typeof judge>[1] = [{ id: "J4", state: { items } }];
  if (bots.length) specs.push({ id: "J5", state: { items: bots } });
  const o = await judge(ctx, specs, typeof args.run_id === "string" ? { runId: args.run_id } : {});
  const sev = o.judgements.find((j) => j.template === "J4")?.interpretation?.items ?? [];
  const bot = o.judgements.find((j) => j.template === "J5")?.interpretation?.items ?? [];
  const triage = items.map((it, i) => {
    const s = sev[i];
    const botIdx = bots.findIndex((b) => b.id === it.id);
    const b = botIdx >= 0 ? bot[botIdx] : undefined;
    const severity = s && s.confidence >= ctx.thresholds.act ? s.value : null;
    return {
      id: it.id, severity, severity_confidence: s?.confidence ?? null, bot_action: b?.value ?? null,
      fix: severity === "P0" || severity === "P1" ? "候选修复：补齐触发条件、错误行为、影响与证据后才进入修复清单" : severity ? "记录不修（P2/P3/不成立）" : "待核实（Jev 低于阈值或不可用）",
    };
  });
  const counts = triage.reduce<Record<string, number>>((acc, x) => ((acc[x.severity ?? "待核实"] = (acc[x.severity ?? "待核实"] ?? 0) + 1), acc), {});
  return { ...t, triage, summary: `共 ${items.length} 条：${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join("，")}。只修确认成立的 P0/P1。`, ...(o.fallback_reason ? { fallback_reason: o.fallback_reason } : {}) };
}

export async function prReply(ctx: ToolContext, args: Record<string, unknown>) {
  const target = requireString(args, "target_id");
  const body = requireString(args, "body");
  const snap = await node<Snapshot>(ctx, "pr/snapshot", prArgs(args));
  await assertNotHandedOff(ctx.host, snap.pr.repo, snap.pr.number);
  const preview = body.length > 180 ? body.slice(0, 180) + "…" : body;
  const c = await ctx.host.confirm({ body: `在 ${snap.pr.repo}#${snap.pr.number} ${target === "issue" ? "主讨论区" : "评审线程"}发表回复${args.resolve ? "并标记已解决" : ""}：\n${preview}`, confirmText: "发表", cancelText: "先不发" });
  if (!c.ok) throw new KeelError("CONFIRM_UNAVAILABLE", `没能弹出确认框（${c.errorCode ?? "未知"}），未发表。`);
  if (!c.confirmed) throw new KeelError("USER_DECLINED", "用户取消了这次回复，未发表。不要换个说法再弹一次。");
  const r = await node(ctx, "pr/reply", { repo: snap.pr.repo, pr: snap.pr.number, target_id: target, body, resolve: args.resolve === true });
  if (typeof args.run_id === "string") await append(ctx.host, { run_id: args.run_id, kind: "step", summary: `pr_reply ${r.url}` });
  return r;
}

export async function prBoard(ctx: ToolContext, args: Record<string, unknown>) {
  const rows = await node<{ repo: string; number: number; title: string; url: string; isDraft: boolean; preset: string }[]>(ctx, "pr/board", Array.isArray(args.repos) ? { repos: args.repos } : {});
  const detailed = [];
  for (const r of rows.slice(0, 15)) {
    try {
      const s = await status(ctx, { repo: r.repo, pr: r.number }, { jev: false });
      detailed.push({ repo: r.repo, number: r.number, title: r.title, url: r.url, preset: r.preset, decision: s.decision, next_action: s.nextAction, handed_off: s.handedOff, mergeable: s.decision.kind === "ready" });
    } catch (e) {
      detailed.push({ repo: r.repo, number: r.number, title: r.title, url: r.url, preset: r.preset, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    }
  }
  const ready = detailed.filter((d) => "mergeable" in d && d.mergeable).length;
  ctx.host.broadcast({ type: "board", rows: detailed, at: new Date(ctx.host.now()).toISOString() });
  ctx.host.badge(ready > 0, ready ? `${ready} 个 PR 可合并` : undefined);
  await ctx.host.fs({ op: "write", root: "data", path: "board/latest.json", content: JSON.stringify({ at: new Date(ctx.host.now()).toISOString(), rows: detailed }) });
  return { rows: detailed, total: rows.length, shown: detailed.length, mergeable: ready };
}
