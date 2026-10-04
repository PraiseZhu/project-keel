// Orca routing.json is the single source of truth for worker models. Read it fresh every
// call; unreadable or malformed → fail closed (ROUTING_UNREADABLE). Never invent a model.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RouteSpec, RouteWithFallbacks } from "../../shared/types.ts";
import { ToolError } from "../env.ts";

export const ROLE_TIER: Readonly<Record<string, string>> = { developer: "execute", reviewer: "review", tester: "e2e", merger: "pr_merge" };

function spec(v: unknown, where: string): RouteSpec {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o.agent !== "string" || !o.agent || typeof o.model !== "string" || !o.model)
    throw new ToolError("ROUTING_UNREADABLE", `routing.json 的 ${where} 缺少 agent 或 model。按规则 fail-closed，请修复配置后重试。`);
  return {
    agent: o.agent,
    model: o.model,
    ...(typeof o.effort === "string" ? { effort: o.effort } : {}),
    ...(typeof o.provider_id === "string" ? { provider_id: o.provider_id } : {}),
  };
}

export function tierOf(data: Record<string, unknown>, tier: string, leadModel?: string | null): RouteWithFallbacks {
  let raw = data[tier] as Record<string, unknown> | undefined;
  let label = tier;
  const lead = (leadModel ?? "").replace(/^[^/]+\//, "");
  const whenGpt = (raw?.when_lead as Record<string, unknown> | undefined)?.gpt;
  if (tier === "review" && lead.startsWith("gpt-") && whenGpt) {
    raw = whenGpt as Record<string, unknown>;
    label = "review.when_lead.gpt";
  }
  if (!raw) throw new ToolError("ROUTING_UNREADABLE", `routing.json 没有 ${tier} 档。按规则 fail-closed。`);
  const fallbacks = Array.isArray(raw.fallbacks) ? raw.fallbacks.map((f, i) => spec(f, `${label}.fallbacks[${i}]`)) : [];
  return { ...spec(raw, label), tier: label, fallbacks };
}

export function readRouting(path: string | null): { data: Record<string, unknown>; sha256: string; path: string } {
  if (!path) throw new ToolError("ROUTING_UNREADABLE", "没有配置 routing.json 路径（个人 profile 的 routingPath）。按规则 fail-closed。");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ToolError("ROUTING_UNREADABLE", `读不到 routing.json：${path}。按规则 fail-closed，不自行换模型。`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ToolError("ROUTING_UNREADABLE", "routing.json 不是合法 JSON。按规则 fail-closed。");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new ToolError("ROUTING_UNREADABLE", "routing.json 顶层不是对象。");
  return { data: data as Record<string, unknown>, sha256: createHash("sha256").update(text).digest("hex"), path };
}

export function roles(path: string | null, leadModel?: string | null) {
  const r = readRouting(path);
  const out: Record<string, RouteWithFallbacks> = {};
  for (const [role, tier] of Object.entries(ROLE_TIER)) if (r.data[tier]) out[role] = tierOf(r.data, tier, leadModel);
  return { source: r.path, sha256: r.sha256, updated: (r.data.updated as string) ?? null, lead_model: leadModel ?? null, roles: out };
}
