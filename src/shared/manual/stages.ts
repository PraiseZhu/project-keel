// Four work stages over the ModelManual, and the rules that keep every selectable route runnable.
// 查资料 is the lead's own one-shot sub (fixed per lead, not configurable); 想方案 / 写代码 / 做检查 are Workers.

import { family } from "../fanout.ts";
import type { AgentModel, Harness, ModelManual, Profile, Route, Slot } from "./schema.ts";

export const STAGE_HARNESSES = ["claude-code", "codex"] as const;
export type StageHarness = (typeof STAGE_HARNESSES)[number];
export type StageId = "plan" | "code" | "review";

export const STAGE_HARNESS_LABELS: Record<StageHarness, string> = { "claude-code": "Claude Code", codex: "Codex" };

/** provider_id marker for a 查资料 sub: the lead's own default route, not a configured gateway route. */
export const LEAD_DEFAULT_PROVIDER = "lead-default";

/** 查资料 sub per lead. Claude Code subs only accept aliases; Codex subs only reach the lead's own gateway. */
export const RESEARCH_SUB: Record<StageHarness, { readonly model: string; readonly label: string; readonly note: string }> = {
  "claude-code": {
    model: "haiku",
    label: "Haiku",
    note: "Agent 工具填 model=haiku；主控当前不是 Claude 模型（如 grok）时不填 model，跟主控走。",
  },
  codex: {
    model: "gpt-6-luna",
    label: "gpt-6-luna",
    note: "spawn_agent 填与主控同一网关的 gpt-6-luna（Art Cindy 填 gpt-6-luna）；该 id 不可用时不填 model，跟主控走。",
  },
};

/** 查资料 fans out into this many parallel subs. Codex allows 6 open subs per session, so 3 leaves room. */
export const RESEARCH_PARALLEL = 3;

export function isStageHarness(value: unknown): value is StageHarness {
  return value === "claude-code" || value === "codex";
}

export function otherHarness(h: StageHarness): StageHarness {
  return h === "codex" ? "claude-code" : "codex";
}

/** Why a model × harness × gateway combination cannot run. undefined = runnable as far as KEEL knows. */
export function blockedReason(agent: string, providerId: string, model: string): string | undefined {
  if (agent === "pi") return "Pi 不用于 KEEL 派工，请选 Claude Code 或 Codex。";
  if (!isStageHarness(agent)) return `不支持的执行框架 ${agent}。`;
  if (agent === "claude-code" && providerId === "art-cindy" && /^gpt-/i.test(model)) {
    return "Claude Code 走 Art Cindy 的 GPT 会被网关拒绝（403），请改选 Codex 或 XD 网关。";
  }
  return undefined;
}

/** Harnesses a stage may pick from. 想方案 takes the other harness than the lead; 做检查 the other one than the writer. */
export function allowedHarnesses(stage: StageId, lead: StageHarness, writer?: Harness): StageHarness[] {
  if (stage === "plan") return [otherHarness(lead)];
  if (stage === "review" && isStageHarness(writer)) return [otherHarness(writer)];
  return [...STAGE_HARNESSES];
}

/** 做检查 must differ from 写代码 in harness and in model family (grok on Codex vs grok on Claude Code still clash). */
export function clashesWithWriter(agent: string, model: string, writer: { readonly agent: string; readonly model: string }): boolean {
  return agent === writer.agent || family(model) === family(writer.model);
}

export function stageModelAllowed(stage: StageId, model: Pick<AgentModel, "agent" | "id" | "providerId" | "visible">, lead: StageHarness, writer?: Harness, writerModel?: string): boolean {
  if (model.visible === false) return false;
  if (blockedReason(model.agent, model.providerId, model.id)) return false;
  if (stage === "review" && writerModel !== undefined && family(model.id) === family(writerModel)) return false;
  return (allowedHarnesses(stage, lead, writer) as string[]).includes(model.agent);
}

export interface StageRoutes {
  readonly plan?: Route;
  readonly code?: Slot;
  readonly review: { readonly primary?: Route; readonly fallbacks: readonly Route[] };
}

function profileOf(manual: ModelManual, profileId: string): Profile | undefined {
  return manual.profiles.find((p) => p.id === profileId);
}

/** Current stage routes on the default column. 做检查 without an explicit route still follows 想方案 (old manuals). */
export function readStages(manual: ModelManual, profileId: string): StageRoutes {
  const p = profileOf(manual, profileId);
  const col = p?.nodes.default;
  const plan = col?.architect?.primary;
  const review = p?.final_review_route
    ? { primary: p.final_review_route, fallbacks: p.final_review_fallbacks ?? [] }
    : { ...(plan ? { primary: plan } : {}), fallbacks: col?.architect?.fallbacks ?? [] };
  return { ...(plan ? { plan } : {}), ...(col?.worker ? { code: col.worker } : {}), review };
}

function patch(manual: ModelManual, profileId: string, f: (p: Profile) => Profile): ModelManual {
  return { ...manual, profiles: manual.profiles.map((p) => (p.id === profileId ? f(p) : p)) };
}

/** 想方案: one Worker route. Drops direction overrides so 方向裁决 follows the same route. */
export function setPlanRoute(manual: ModelManual, profileId: string, route: Route): ModelManual {
  return patch(manual, profileId, (p) => {
    const { direction_route: _r, direction_collaborators: _c, ...rest } = p;
    return { ...rest, nodes: { ...p.nodes, default: { ...(p.nodes.default ?? {}), architect: { primary: route } } } };
  });
}

export function setCodeRoutes(manual: ModelManual, profileId: string, primary: Route, fallback?: Route): ModelManual {
  return patch(manual, profileId, (p) => ({
    ...p,
    nodes: { ...p.nodes, default: { ...(p.nodes.default ?? {}), worker: { primary, ...(fallback ? { fallbacks: [fallback] } : {}) } } },
  }));
}

export function setReviewRoutes(manual: ModelManual, profileId: string, primary: Route, fallback?: Route): ModelManual {
  return patch(manual, profileId, (p) => {
    const { final_review_collaborators: _c, final_review_fallbacks: _f, ...rest } = p;
    return { ...rest, final_review_route: primary, ...(fallback ? { final_review_fallbacks: [fallback] } : {}) };
  });
}

/** 按任务类型 is gone: keep only the default column, and drop collaborators that no stage uses any more. */
export function stripRetiredFields(manual: ModelManual): ModelManual {
  return {
    ...manual,
    profiles: manual.profiles.map((p) => {
      const { direction_collaborators: _d, final_review_collaborators: _f, ...rest } = p;
      const col = p.nodes.default;
      if (!col) return { ...rest, nodes: {} };
      const cleaned = Object.fromEntries(Object.entries(col).map(([role, slot]) => {
        const { collaborators: _c, ...s } = slot as Slot;
        return [role, s];
      }));
      return { ...rest, nodes: { default: cleaned } };
    }),
  };
}
