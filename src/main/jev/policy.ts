// Threshold policy for Jev answers, aligned with approve-exec: act at ≥0.75 (J7 ≥0.8),
// otherwise re-ask once, then fall back to the smallest reversible option.
// Jev unavailable on a collateral-file judgement → stop (approve-exec D2).

import { DEFAULT_THRESHOLDS, type JevThresholds } from "../../shared/types.ts";
import type { Interpretation, Template } from "./templates.ts";

export type PolicyAction = "act" | "reask" | "minimal" | "stop";

export interface PolicyResult {
  readonly action: PolicyAction;
  readonly threshold: number;
  readonly reason: string;
  readonly value: string | number | boolean | null;
}

export function decide(args: {
  readonly template: Pick<Template, "strict" | "collateral" | "minimal">;
  readonly interpretation: Interpretation | null;
  readonly alreadyReasked: boolean;
  readonly thresholds?: JevThresholds;
}): PolicyResult {
  const t = args.thresholds ?? DEFAULT_THRESHOLDS;
  const threshold = args.template.strict ? t.strict : t.act;
  const i = args.interpretation;
  if (i === null) {
    if (args.template.collateral) return { action: "stop", threshold, reason: "Jev 不可用且该判断涉及连带文件，按规则停下回报。", value: null };
    return { action: "minimal", threshold, reason: "Jev 不可用，按“改动最小、可撤回”取保守选项。", value: args.template.minimal };
  }
  if (i.confidence >= threshold) return { action: "act", threshold, reason: `confidence ${i.confidence.toFixed(2)} ≥ ${threshold}，可直接执行。`, value: i.value };
  if (!args.alreadyReasked) return { action: "reask", threshold, reason: `confidence ${i.confidence.toFixed(2)} < ${threshold}，补充上下文后再问一次。`, value: i.value };
  return { action: "minimal", threshold, reason: `重问后 confidence ${i.confidence.toFixed(2)} 仍 < ${threshold}，取改动最小、可撤回的选项。`, value: args.template.minimal };
}
