// fanout_plan / fanout_ingest. Keel plans and ingests; the main Agent dispatches Orca workers.

import type { FanoutKind } from "../../shared/fanout.ts";
import { KeelError } from "../host.ts";
import { node, requireString, type ToolContext } from "../context.ts";
import { judge } from "../judge.ts";
import { append } from "../ledger.ts";
import { classifyAgreement, crossJudge, dedupe, findingsOf, swarmRow } from "./ingest.ts";
import { createWorkersPayload, outputContract, promptFor, type PreparedLane } from "./spec.ts";

const KINDS = ["arena", "interrogate", "swarm"];

interface Prepared {
  fanout_id: string;
  kind: FanoutKind;
  base_ref: string | null;
  repo_root: string | null;
  routing: { path: string; sha256: string; updated: string | null };
  lanes: PreparedLane[];
  task?: string;
}

function fanoutId(now: number): string {
  return `fo-${new Date(now).toISOString().replace(/[-:T]/g, "").slice(2, 12)}-${Math.floor(Math.random() * 0xfff).toString(16).padStart(3, "0")}`;
}

export async function fanoutPlan(ctx: ToolContext, args: Record<string, unknown>) {
  const kind = requireString(args, "kind") as FanoutKind;
  if (!KINDS.includes(kind)) throw new KeelError("INVALID_INPUT", "kind 只能是 arena、interrogate、swarm。");
  const task = requireString(args, "task");
  const id = fanoutId(ctx.host.now());
  const prep = await node<Prepared>(ctx, "fanout/prepare", {
    fanout_id: id, kind,
    ...(typeof args.repo_dir === "string" ? { repo_dir: args.repo_dir } : {}),
    ...(typeof args.base_ref === "string" ? { base_ref: args.base_ref } : {}),
    ...(typeof args.lanes === "number" ? { lanes: args.lanes } : {}),
    ...(Array.isArray(args.slices) ? { slices: args.slices } : {}),
    lead_model: typeof args.lead_model === "string" ? args.lead_model : null,
    lead_agent: typeof args.lead_agent === "string" ? args.lead_agent : null,
  });
  const rubric = typeof args.rubric === "string" ? args.rubric : undefined;
  const lanes = prep.lanes.map((l) => ({ label: l.label, role: l.role, lane: l.lane, route: { agent: l.route.agent, model: l.route.model, effort: l.route.effort, provider_id: l.route.provider_id, tier: l.route.tier }, fallbacks: l.route.fallbacks, working_dir: l.working_dir, branch: l.branch, note: l.note ?? null, prompt: promptFor(kind, l, task, rubric), output_contract: outputContract(l) }));
  const record = { ...prep, task, rubric: rubric ?? null, created_at: new Date(ctx.host.now()).toISOString() };
  await ctx.host.fs({ op: "write", root: "data", path: `fanout/${id}.json`, content: JSON.stringify(record, null, 2) });
  if (typeof args.run_id === "string") await append(ctx.host, { run_id: args.run_id, kind: "step", summary: `fanout_plan ${kind} ${id}：${lanes.length} 条车道（${lanes.map((l) => `${l.label}=${l.route.model}/${l.route.effort ?? "-"}`).join("，")}）`, evidence: { routing_sha256: prep.routing.sha256 } });
  ctx.host.broadcast({ type: "fanout", fanout_id: id, lanes });
  return {
    fanout_id: id, kind, routing: prep.routing, base_ref: prep.base_ref, lanes,
    create_workers: createWorkersPayload(id, kind, prep.lanes, task, rubric),
    dispatch: [
      '先调用 start_team({ worker_permission_mode: "bypassPermissions" })（已是 Lead 也要显式传）。',
      "把 create_workers 字段原样传给 create_workers；派发说明为每个 Worker 标注 (model/effort)，有 note 的照写。",
      "primary 报 NO_PROVIDER_FOR_AGENT / PROVIDER_ROUTE_UNAVAILABLE / BUDGET_MODEL_REQUIRES_API_MODE 时按该车道 fallbacks 顺序降级并写明原因；用尽即停，不自找替代。",
      `收齐后调用 fanout_ingest({ fanout_id: "${id}", kind: "${kind}", lane_results: [...] })。`,
      "没有 Orca（当前 harness 无 create_workers）时：只读车道可用原生 subagent 降级，必须标注“同模型降级，非多模型”；写车道不降级。",
    ],
  };
}

export async function fanoutIngest(ctx: ToolContext, args: Record<string, unknown>) {
  const id = requireString(args, "fanout_id");
  const rec = await ctx.host.fs({ op: "read", root: "data", path: `fanout/${id}.json` });
  if (!rec.ok || !rec.content) throw new KeelError("FANOUT_NOT_FOUND", `找不到 fanout ${id}。先调用 fanout_plan。`);
  const prep = JSON.parse(rec.content) as Prepared & { task: string };
  const kind = (typeof args.kind === "string" ? args.kind : prep.kind) as FanoutKind;
  const results = (Array.isArray(args.lane_results) ? args.lane_results : []) as { label: string; text?: string }[];
  const runOpts = typeof args.run_id === "string" ? { runId: args.run_id } : {};
  let out: Record<string, unknown>;
  if (kind === "arena") {
    const candidates = prep.lanes.filter((l) => l.lane === "candidate" && l.working_dir);
    const diffs = prep.repo_root ? await node<any[]>(ctx, "fanout/collect", { repo_dir: prep.repo_root, base_ref: prep.base_ref, lanes: candidates.map((c) => ({ label: c.label, working_dir: c.working_dir })) }) : [];
    const judgeText = results.find((r) => r.label === "judge")?.text ?? "";
    const cross = crossJudge(judgeText);
    const o = await judge(ctx, [{ id: "J3", state: { task: prep.task, candidates: diffs.map((d) => ({ label: d.label, stat: d.stat, patch: d.patch, report: results.find((r) => r.label === d.label)?.text?.slice(0, 3000) ?? "" })) }, options: candidates.map((c) => c.label) }], runOpts);
    const j3 = o.judgements[0]!;
    const jevBase = j3.policy.action === "act" ? String(j3.policy.value) : null;
    out = { candidates: diffs.map((d) => ({ label: d.label, head: d.head, stat: d.stat, truncated: d.truncated })), cross_judge: cross, jev: { base: j3.interpretation?.value ?? null, confidence: j3.interpretation?.confidence ?? 0, policy: j3.policy.action, ranked: j3.interpretation?.ranked ?? [] }, agree: jevBase !== null && jevBase === cross.base, next: jevBase !== null && jevBase === cross.base ? `Jev 与交叉评审一致选 ${jevBase} 做基础；主 Agent 自评确认后嫁接其他候选优点。` : "Jev、交叉评审未一致：主 Agent 重读各候选理由后自行决定，并在台账写明依据。", ...(o.fallback_reason ? { fallback_reason: o.fallback_reason } : {}) };
  } else if (kind === "interrogate") {
    const perLane = results.map((r) => ({ label: r.label, findings: findingsOf(r.text ?? "") }));
    const merged = dedupe(perLane);
    const o = merged.length ? await judge(ctx, [{ id: "J4", state: { items: merged.map((m) => ({ id: m.id, ...m.finding, found_by: m.lanes })) } }], runOpts) : null;
    const items = o?.judgements[0]?.interpretation?.items ?? [];
    const rows = merged.map((m, i) => {
      const s = items[i];
      const sev = s && s.confidence >= ctx.thresholds.act ? s.value : null;
      return { id: m.id, file: m.finding.file, line: m.finding.line, title: m.finding.title, lanes: m.lanes, agreement: classifyAgreement(m), guesses: m.guesses, severity: sev, severity_confidence: s?.confidence ?? null, fix_candidate: sev === "P0" || sev === "P1" };
    });
    out = { parsed: perLane.map((p) => ({ label: p.label, findings: p.findings.length })), findings: rows, consensus: rows.filter((r) => r.agreement === "consensus").length, single: rows.filter((r) => r.agreement === "single").length, disputed: rows.filter((r) => r.agreement === "disputed").length, next: "只有 fix_candidate 且主 Agent 补齐触发条件、影响与证据的条目进入修复清单；P2/P3 记录不修。", ...(o?.fallback_reason ? { fallback_reason: o.fallback_reason } : {}) };
  } else {
    const rows = results.map((r) => swarmRow(r.label, r.text ?? ""));
    const expected = prep.lanes.map((l) => l.label);
    const missingLanes = expected.filter((l) => !results.some((r) => r.label === l));
    out = { rows, missing_lanes: missingLanes, gaps: rows.filter((r) => r.gap).map((r) => ({ label: r.label, gap: r.gap })), all_pass: !missingLanes.length && rows.every((r) => r.verdict === "PASS" && !r.gap) };
  }
  if (args.cleanup === true && prep.repo_root) out.cleanup = await node(ctx, "fanout/cleanup", { repo_dir: prep.repo_root, fanout_id: id });
  if (typeof args.run_id === "string") await append(ctx.host, { run_id: args.run_id, kind: "evidence", summary: `fanout_ingest ${kind} ${id}`, evidence: out });
  return { fanout_id: id, kind, ...out };
}
