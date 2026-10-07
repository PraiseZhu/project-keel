// Pure completion gates. Interpreter (another PR) calls these; this module does not I/O.

import type { ContentFingerprint } from "../../node/git/fingerprint.ts";
import { levelMeets, type GraphVerdict, type OrchLevel } from "./verdict.ts";

export const DONE_PR_STATUS = ["report_mergeable", "stopped_after_handoff", "report_merged_or_closed"] as const;
export type DonePrStatus = (typeof DONE_PR_STATUS)[number];
export type DoneNext = "verify-head" | "recheck-ci" | "wait" | null;

export interface ScRow {
  readonly id: string;
  readonly hasEvidence: boolean;
  readonly minLevel?: OrchLevel;
}

export interface CurrentPatch {
  readonly head_sha: string;
  readonly base_sha: string;
  readonly patch_id: string | null;
  readonly patch_ok: boolean;
}

export interface ChangeGraphDoneInput {
  readonly pr_status: string;
  readonly author_families: readonly string[];
  readonly verdict: GraphVerdict | null;
  readonly current: CurrentPatch;
  readonly sc: readonly ScRow[];
  readonly openHumanGates: number;
}

export interface ChangeGraphDoneResult {
  readonly done: boolean;
  readonly missing: readonly string[];
  readonly next: DoneNext;
}

export interface InvestigationDoneInput {
  readonly reportComplete: boolean;
  readonly reportCitation?: string;
  readonly sc: readonly ScRow[];
  readonly openHumanGates: number;
  readonly start: ContentFingerprint;
  readonly current: ContentFingerprint;
}

function scMissing(sc: readonly ScRow[]): string[] {
  return sc.filter((s) => !s.hasEvidence).map((s) => `SC ${s.id} 没有证据`);
}

function requiredLevel(sc: readonly ScRow[]): OrchLevel {
  let req: OrchLevel = "unit-test-verified";
  for (const s of sc) {
    if (s.minLevel === "live-ui-verified") req = "live-ui-verified";
  }
  return req;
}

export function isChangeGraphDone(input: ChangeGraphDoneInput): ChangeGraphDoneResult {
  const missing: string[] = [];
  if (!(DONE_PR_STATUS as readonly string[]).includes(input.pr_status)) {
    missing.push(`pr_status 是 ${input.pr_status}，不是可合并/已交接/已关闭`);
  }
  if (input.openHumanGates > 0) missing.push(`还有 ${input.openHumanGates} 个未结人工门`);
  missing.push(...scMissing(input.sc));

  const v = input.verdict;
  const cur = input.current;
  if (!v) missing.push("当前 head 没有非作者 verdict");
  else {
    if (v.head_sha !== cur.head_sha) missing.push("verdict 绑定的 head 不是当前 head");
    if (input.author_families.includes(v.by_family)) {
      missing.push(`验证者模型族 ${v.by_family} 属于作者族（${input.author_families.join("、")}）`);
    }
    const need = requiredLevel(input.sc);
    if (!levelMeets(v.level, need)) missing.push(`verdict 级别 ${v.level} 低于要求的 ${need}`);
    if (!cur.patch_ok || !cur.patch_id) missing.push("当前 base...head 的 patch_id 无法确认");
    else if (v.patch_id !== cur.patch_id) missing.push("记录的 patch_id 与当前补丁不同");
    else if (v.base_sha !== cur.base_sha) missing.push("base 已变化，需重读 mergeability 与 CI，不复用旧快照");
  }
  if (!v && (!cur.patch_ok || !cur.patch_id)) missing.push("当前 base...head 的 patch_id 无法确认");

  let next: DoneNext = missing.length ? "wait" : null;
  if (v) {
    const patchKnown = Boolean(cur.patch_ok && cur.patch_id);
    const patchDiffers = patchKnown && v.patch_id !== cur.patch_id;
    if (v.head_sha !== cur.head_sha || patchDiffers) next = "verify-head";
    else if (patchKnown && v.patch_id === cur.patch_id && v.base_sha !== cur.base_sha) next = "recheck-ci";
  } else if (cur.head_sha) {
    next = "verify-head";
  }
  if (!cur.patch_ok && next !== "verify-head") next = "wait";
  if (missing.length === 0) next = null;
  return { done: missing.length === 0, missing, next };
}

export function isInvestigationDone(input: InvestigationDoneInput): { done: boolean; missing: readonly string[] } {
  const missing: string[] = [];
  if (!input.reportComplete) missing.push("报告节点未完成");
  if (!input.reportCitation?.trim()) missing.push("报告没有引用");
  if (input.openHumanGates > 0) missing.push(`还有 ${input.openHumanGates} 个未结人工门`);
  missing.push(...scMissing(input.sc));
  const a = input.start;
  const b = input.current;
  if (a.head !== b.head || a.status_digest !== b.status_digest || a.content_hash !== b.content_hash) {
    missing.push("内容指纹与起始记录不一致（本轮引入了源码或 Git 变化）");
  }
  return { done: missing.length === 0, missing };
}
