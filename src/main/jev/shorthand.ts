// The `jev` tool accepts the legacy typesafe-jev `evaluate` shape verbatim, or a
// one-question shorthand for everyday use. This file converts and summarises.

import { KeelError } from "../host.ts";
import type { EvaluateArgs, EvaluateResult } from "./client.ts";
import { answerConfidence } from "./client.ts";

export interface Shorthand {
  readonly question: string;
  readonly kind: "choice" | "score" | "yesno";
  readonly options?: readonly string[];
  readonly levels?: readonly string[];
  readonly context?: unknown;
  readonly model?: string;
}

export function isShorthand(args: Record<string, unknown>): boolean {
  return typeof args.question === "string" && args.questions === undefined;
}

export function fromShorthand(s: Shorthand): EvaluateArgs {
  if (!s.question.trim()) throw new KeelError("INVALID_INPUT", "question 不能为空。");
  const state = s.context ?? s.question;
  let q;
  if (s.kind === "choice") {
    if (!s.options?.length) throw new KeelError("INVALID_INPUT", "kind=choice 需要 options（1–255 项）。");
    q = { type: "choice" as const, instructions: s.question, criteria: Object.fromEntries(s.options.map((o) => [o, null])) };
  } else if (s.kind === "score") {
    const levels = s.levels?.length ? s.levels : ["低", "中", "高"];
    q = { type: "score" as const, instructions: s.question, criteria: [...levels] };
  } else if (s.kind === "yesno") {
    q = { type: "noul" as const, instructions: s.question };
  } else {
    throw new KeelError("INVALID_INPUT", "kind 只能是 choice、score 或 yesno。");
  }
  return { state, questions: { answer: q }, ...(s.model ? { model: s.model } : {}) };
}

export function summarise(result: EvaluateResult, threshold: number): { summary: string; confidence_hint: Record<string, { confidence: number; meets_threshold: boolean }> } {
  const parts: string[] = [];
  const hint: Record<string, { confidence: number; meets_threshold: boolean }> = {};
  for (const [id, a] of Object.entries(result.answers)) {
    const c = answerConfidence(a);
    hint[id] = { confidence: Number(c.toFixed(3)), meets_threshold: c >= threshold };
    const label = id === "answer" ? "" : `${id}：`;
    if (a.type === "choice") parts.push(`${label}选「${a.choice}」（confidence ${c.toFixed(2)}）`);
    else if (a.type === "score") parts.push(`${label}评分 ${a.score}（confidence ${c.toFixed(2)}）`);
    else parts.push(`${label}${(a.noul ?? 0) >= 0.5 ? "是" : "否"}（为真概率 ${(a.noul ?? 0).toFixed(2)}）`);
  }
  const low = Object.values(hint).some((h) => !h.meets_threshold);
  return { summary: `Jev 判断：${parts.join("；")}。${low ? `有答案低于 ${threshold} 执行线，仅供参考。` : ""}`, confidence_hint: hint };
}
