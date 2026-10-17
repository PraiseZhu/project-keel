import { family } from "../fanout.ts";
import { resolve, resolveFinalReview } from "./resolve.ts";
import { KV_MAX_BYTES, MAX_FALLBACKS, MAX_COLLABORATORS, ManualError, ROLES, TASK_TYPES, type AgentModel, type ModelManual, type Route, type Slot, type TaskType } from "./schema.ts";

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

function checkSlot(models: readonly AgentModel[], slot: Slot, path: string, out: ManualIssue[]): void {
  checkRoute(models, slot.primary, `${path}/primary`, out);
  const fallbacks = slot.fallbacks ?? [];
  if (fallbacks.length > MAX_FALLBACKS) out.push({ path: `${path}/fallbacks`, message: `备路线最多 ${MAX_FALLBACKS} 条。` });
  fallbacks.forEach((f, i) => checkRoute(models, f, `${path}/fallbacks/${i}`, out));
  checkCollaborators(models, slot.collaborators, `${path}/collaborators`, out);
}

function checkCollaborators(models: readonly AgentModel[], routes: readonly Route[] | undefined, path: string, out: ManualIssue[]): void {
  if (!routes) return;
  if (routes.length > MAX_COLLABORATORS) out.push({ path, message: `协作模型最多 ${MAX_COLLABORATORS} 项。` });
  routes.forEach((route, index) => checkRoute(models, route, `${path}/${index}`, out));
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

function collectFamilyIssues(manual: ModelManual, out: ManualIssue[]): void {
  for (const profile of manual.profiles) {
    for (const taskType of TASK_TYPES) {
      let worker: ReturnType<typeof resolve> | undefined;
      let verifier: ReturnType<typeof resolve> | undefined;
      try {
        worker = resolve(manual, profile.id, taskType, "worker");
      } catch (e) {
        if (e instanceof ManualError) out.push({ path: e.path, message: e.message });
        else throw e;
      }
      try {
        verifier = resolveFinalReview(manual, profile.id, taskType);
      } catch (e) {
        if (e instanceof ManualError) out.push({ path: e.path, message: e.message });
        else throw e;
      }
      if (!worker || !verifier) continue;
      const wf = family(worker.primary.model);
      const reviewRoutes = [verifier.primary, ...(verifier.collaborators ?? [])];
      if (reviewRoutes.some((route) => family(route.model) === wf)) {
        out.push({
          path: `profiles/${profile.id}/nodes/${taskType}`,
          message: `同一方案、同一任务类型下终审与 Worker 不能同模型族（写手 ${worker.primary.model}；终审 ${reviewRoutes.map((route) => route.model).join('、')}）。`,
        });
      }
    }
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

  for (const profile of manual.profiles) {
    checkRoute(agentModels, profile.lead, `profiles/${profile.id}/lead`, out);
    if (profile.direction_route) checkRoute(agentModels, profile.direction_route, `profiles/${profile.id}/direction_route`, out);
    if (profile.final_review_route) checkRoute(agentModels, profile.final_review_route, `profiles/${profile.id}/final_review_route`, out);
    checkCollaborators(agentModels, profile.direction_collaborators, `profiles/${profile.id}/direction_collaborators`, out);
    checkCollaborators(agentModels, profile.final_review_collaborators, `profiles/${profile.id}/final_review_collaborators`, out);
    for (const taskType of Object.keys(profile.nodes) as TaskType[]) {
      const col = profile.nodes[taskType];
      if (!col) continue;
      for (const role of ROLES) {
        const slot = col[role];
        if (role === 'worker' && slot?.collaborators?.length) out.push({ path: `profiles/${profile.id}/nodes/${taskType}/worker`, message: '写代码保持单一写手，协作模型只用于只读任务。' });
        if (slot) checkSlot(agentModels, slot, `profiles/${profile.id}/nodes/${taskType}/${role}`, out);
      }
    }
  }

  collectInheritIssues(manual, out);
  collectHarnessDefaultIssues(manual, out);
  collectFamilyIssues(manual, out);

  const seen = new Set<string>();
  return out.filter((issue) => {
    const key = `${issue.path}\0${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
