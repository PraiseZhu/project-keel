// Pure lane logic shared by main.js and the Node worker.
// Lane = how the user's rules treat a repo: draft policy, Ready gate, post-Ready owner.

import { LANE_PRESETS, type DecisionKind, type KeelProfile, type LaneMatch, type LaneRule, type PrAction, type RequiredGate, type Verification } from "./types.ts";

export function resolveLane(profile: KeelProfile, repo: string): { match: LaneMatch | null; rule: LaneRule } {
  const key = repo.toLowerCase();
  const match = profile.lanes.find((l) => l.repo.toLowerCase() === key) ?? null;
  const base = LANE_PRESETS[match?.preset ?? "personal"];
  const rule: LaneRule = match?.baseRuleFiles ? { ...base, baseRuleFiles: { ...base.baseRuleFiles, ...match.baseRuleFiles } } : base;
  return { match, rule };
}

/** Draft flag for `pr_open`. A draft-first lane forces Draft regardless of the request. */
export function draftFor(rule: LaneRule, requested: boolean | undefined): { draft: boolean; forced: boolean } {
  if (rule.draftFirst) return { draft: true, forced: requested === false };
  return { draft: requested ?? false, forced: false };
}

/** Evaluate the Ready gate from required names and check results. */
export function evaluateGate(rule: LaneRule, required: readonly string[], results: readonly { name: string; bucket: string }[], sources: readonly string[]): RequiredGate {
  if (rule.readyGate === "none") return { applies: false, required: [], passed: [], failing: [], pending: [], missing: [], ok: true, sources: [] };
  const names = [...new Set(required)].sort();
  const byName = new Map<string, string>();
  for (const r of results) byName.set(r.name, r.bucket);
  const passed: string[] = [], failing: string[] = [], pending: string[] = [], missing: string[] = [];
  for (const n of names) {
    const b = byName.get(n);
    if (b === undefined) missing.push(n);
    else if (b === "pass") passed.push(n);
    else if (b === "pending") pending.push(n);
    else failing.push(n);
  }
  const ok = names.length > 0 && passed.length === names.length;
  return { applies: true, required: names, passed, failing, pending, missing: names.length === 0 ? ["(no required checks found)"] : missing, ok, sources: [...sources] };
}

export interface ActionInput {
  readonly rule: LaneRule;
  readonly decision: DecisionKind;
  readonly blocker?: string;
  readonly isDraft: boolean;
  readonly gate: RequiredGate;
  readonly handedOff: boolean;
  /** False when the lane's `verifyCheck` has not passed on the current head; omitted when the lane has none. */
  readonly verified?: boolean;
}

/** Actions the policy allows next. Jev (J8) may only rank inside this list. Merging is never an action. */
export function allowedActions(i: ActionInput): PrAction[] {
  if (i.handedOff) return ["stopped_after_handoff"];
  if (i.decision === "merged" || i.decision === "closed") return ["report_merged_or_closed"];
  if (i.decision === "blocker") {
    if (i.blocker === "merge-conflicts") return ["report_conflict_rebase_needed"];
    if (i.blocker === "review-threads") return ["triage_review_threads"];
    if (i.blocker === "failing-checks") return ["classify_ci_failure"];
    if (i.blocker === "draft-pr") {
      if (i.verified === false) return ["verify_current_head"];
      return i.gate.ok || !i.gate.applies ? ["mark_ready", "wait_for_ci"] : ["wait_for_ci"];
    }
    return ["wait_for_review"];
  }
  if (i.decision === "waiting") return ["wait_for_ci"];
  // ready — a gated lane that has not passed its Ready gate is not mergeable and cannot hand off.
  if (i.gate.applies && !i.gate.ok) return ["wait_for_ci"];
  if (i.verified === false) return ["verify_current_head"];
  if (i.rule.postReadyOwner === "automation") return ["handoff"];
  return ["report_mergeable"];
}

/** Where the lane's verify status stands on the head the checks were read from. Absent = never posted for this head. */
export function verificationOf(check: string, checks: readonly { name: string; kind: string }[]): Verification {
  const hit = checks.find((c) => c.name === check);
  const state = hit?.kind === "passed" ? "pass" : hit?.kind === "failed" ? "failing" : hit?.kind === "pending" ? "pending" : "missing";
  return { check, state };
}

export const PUSH_LIKE_ACTIONS = new Set(["pr_reply", "pr_open_push", "pr_ready", "worktree_prune_pr"]);
