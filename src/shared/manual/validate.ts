import { family } from "../fanout.ts";
import { resolve, resolveFinalReview, type ResolvedRoutes } from "./resolve.ts";
import { KV_MAX_BYTES, MAX_FALLBACKS, ManualError, type AgentModel, type ModelManual, type Profile, type Route } from "./schema.ts";
import { blockedReason, isStageHarness, otherHarness, STAGE_HARNESS_LABELS } from "./stages.ts";

export type { AgentModel };

export interface ManualIssue {
  readonly path: string;
  readonly message: string;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function matchModel(models: readonly AgentModel[], route: Route): AgentModel | undefined {
  return models.find((m) => m.id === route.model && m.agent === route.agent && m.providerId === route.provider_id);
}

function effortsOf(model: AgentModel): readonly string[] | null {
  if (!model.efforts || model.efforts.length === 0) return null;
  return model.efforts;
}

function checkRoute(models: readonly AgentModel[], route: Route, path: string, out: ManualIssue[]): void {
  const blocked = blockedReason(route.agent, route.provider_id, route.model);
  if (blocked) {
    out.push({ path, message: blocked });
    return;
  }
  const hit = matchModel(models, route);
  if (!hit || hit.visible === false) {
    out.push({ path, message: `模型 ${route.model} 在 agent ${route.agent} / 来源 ${route.provider_id} 下不存在。` });
    return;
  }
  const efforts = effortsOf(hit);
  if (efforts === null) {
    if (route.effort !== undefined) out.push({ path: `${path}/effort`, message: "该项未声明档位，只接受不填 effort。" });
    return;
  }
  if (route.effort !== undefined && !efforts.includes(route.effort)) {
    out.push({ path: `${path}/effort`, message: `档位 ${route.effort} 不在该项已声明的 efforts（${efforts.join("、")}）内。` });
  }
}

function collectInheritIssues(manual: ModelManual, out: ManualIssue[]): void {
  const ids = new Set(manual.profiles.map((p) => p.id));
  for (const profile of manual.profiles) {
    if (!profile.inherit) continue;
    const path = `profiles/${profile.id}/inherit`;
    if (!ids.has(profile.inherit)) {
      out.push({ path, message: `继承引用了不存在的方案 ${profile.inherit}。` });
      continue;
    }
    const seen = new Set<string>();
    let cur: string | undefined = profile.id;
    while (cur) {
      if (seen.has(cur)) {
        out.push({ path, message: `主控方案继承形成循环：${[...seen, cur].join(" → ")}。` });
        break;
      }
      seen.add(cur);
      const next = manual.profiles.find((p) => p.id === cur)?.inherit;
      cur = next;
    }
  }
}

function collectHarnessDefaultIssues(manual: ModelManual, out: ManualIssue[]): void {
  for (const [harness, id] of Object.entries(manual.defaults_by_harness)) {
    if (!id) continue;
    const path = `defaults_by_harness/${harness}`;
    const profile = manual.profiles.find((p) => p.id === id);
    if (!profile) {
      out.push({ path, message: `默认方案 ${id} 不存在。` });
      continue;
    }
    if (profile.harness !== harness) {
      out.push({ path, message: `默认方案 ${id} 的 harness 是 ${profile.harness}，与 ${harness} 不匹配。` });
    }
  }
}

function tryResolve(fn: () => ResolvedRoutes, out: ManualIssue[]): ResolvedRoutes | undefined {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ManualError) {
      out.push({ path: e.path, message: e.message });
      return undefined;
    }
    throw e;
  }
}

function label(agent: string): string {
  return isStageHarness(agent) ? STAGE_HARNESS_LABELS[agent] : agent;
}

/**
 * 想方案 / 写代码 / 做检查 on the default column. 查资料 is the lead's own sub and has nothing to configure.
 * Rules: every route runnable; 想方案 on the other harness than the lead; 写代码 backups on the writer's harness;
 * 做检查 on the other harness and model family than 写代码.
 */
function collectStageIssues(manual: ModelManual, profile: Profile, models: readonly AgentModel[], out: ManualIssue[]): void {
  if (!isStageHarness(profile.harness)) return;
  const base = `profiles/${profile.id}`;
  const planPath = `${base}/nodes/default/architect`;
  const plan = tryResolve(() => resolve(manual, profile.id, "default", "architect"), out);
  if (plan) {
    const want = otherHarness(profile.harness);
    [plan.primary, ...plan.fallbacks].forEach((route, i) => {
      const path = i === 0 ? `${planPath}/primary` : `${planPath}/fallbacks/${i - 1}`;
      checkRoute(models, route, path, out);
      if (route.agent !== want) {
        out.push({ path, message: `想方案要换一家：你用 ${label(profile.harness)} 时，这里只能选 ${label(want)} 的模型。` });
      }
    });
  }
  if (profile.direction_route) checkRoute(models, profile.direction_route, `${base}/direction_route`, out);

  const codePath = `${base}/nodes/default/worker`;
  const code = tryResolve(() => resolve(manual, profile.id, "default", "worker"), out);
  if (code) {
    checkRoute(models, code.primary, `${codePath}/primary`, out);
    if (code.fallbacks.length > MAX_FALLBACKS) out.push({ path: `${codePath}/fallbacks`, message: `备路线最多 ${MAX_FALLBACKS} 条。` });
    code.fallbacks.forEach((route, i) => {
      const path = `${codePath}/fallbacks/${i}`;
      checkRoute(models, route, path, out);
      if (route.agent !== code.primary.agent) out.push({ path, message: `写代码的备用要和主选同一家（${label(code.primary.agent)}）。` });
    });
    if (code.collaborators?.length) out.push({ path: codePath, message: "写代码保持单一写手，协作模型只用于只读任务。" });
  }

  const reviewPath = profile.final_review_route ? `${base}/final_review_route` : planPath;
  const review = tryResolve(() => resolveFinalReview(manual, profile.id, "default"), out);
  if (review && code) {
    const writer = code.primary;
    const wf = family(writer.model);
    [review.primary, ...review.fallbacks].forEach((route, i) => {
      const path = i === 0 ? reviewPath : profile.final_review_route ? `${base}/final_review_fallbacks/${i - 1}` : `${planPath}/fallbacks/${i - 1}`;
      if (profile.final_review_route) checkRoute(models, route, path, out);
      if (route.agent === writer.agent) {
        const want = isStageHarness(writer.agent) ? otherHarness(writer.agent) : undefined;
        out.push({ path, message: `做检查要和写代码不是同一家：写代码用 ${label(writer.agent)}${want ? `，这里只能选 ${label(want)} 的模型` : ""}。` });
      } else if (family(route.model) === wf) {
        out.push({ path, message: `做检查与写代码不能同模型族（写代码 ${writer.model}；做检查 ${route.model}）。` });
      }
    });
  }
}

/**
 * Validate a manual against /agent-models and the full /kv object that would be PUT.
 * Returns a list of {path, message} in Chinese. Never includes secrets.
 */
export function validateManual(manual: ModelManual, agentModels: readonly AgentModel[], kv: unknown): ManualIssue[] {
  const out: ManualIssue[] = [];
  if (!kv || typeof kv !== "object" || Array.isArray(kv)) {
    out.push({ path: "/kv", message: "/kv 必须是 JSON 对象。" });
  } else {
    const bytes = utf8Bytes(JSON.stringify(kv));
    if (bytes > KV_MAX_BYTES) out.push({ path: "/kv", message: `完整 /kv 对象 UTF-8 序列化为 ${bytes} 字节，超过 ${KV_MAX_BYTES} 字节上限。` });
  }

  collectInheritIssues(manual, out);
  collectHarnessDefaultIssues(manual, out);
  if (!out.some((i) => i.path.endsWith("/inherit"))) {
    for (const profile of manual.profiles) collectStageIssues(manual, profile, agentModels, out);
  }

  const seen = new Set<string>();
  return out.filter((issue) => {
    const key = `${issue.path}\0${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
