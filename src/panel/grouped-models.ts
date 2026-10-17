// Four pstack-style groups over Keel's existing five roles + direction / final-review.
// Group edits write the original ModelManual slots; they are not a second source of truth.

import {
  setDirectionCollaborators,
  setDirectionRoute,
  setFinalReviewCollaborators,
  setFinalReviewRoute,
  setSlot,
  withSavedVersion,
} from "./manual-editor.ts";
import { family } from "../shared/fanout.ts";
import { resolve, resolveDirection, resolveFinalReview } from "../shared/manual/resolve.ts";
import {
  MAX_COLLABORATORS,
  type Harness,
  type ModelManual,
  type Role,
  type Route,
  type Slot,
  type TaskType,
} from "../shared/manual/schema.ts";

export const GROUP_IDS = ["research", "plan", "code", "review"] as const;
export type GroupId = (typeof GROUP_IDS)[number];

export type FineTuneId = Role | "direction" | "final-review";

export type GroupTarget =
  | { readonly kind: "slot"; readonly role: Role }
  | { readonly kind: "direction" }
  | { readonly kind: "final-review" };

export interface GroupDef {
  readonly id: GroupId;
  readonly name: string;
  readonly description: string;
  readonly allowCollaborators: boolean;
  readonly targets: readonly GroupTarget[];
  readonly fineTune: readonly FineTuneId[];
}

export const GROUPS: readonly GroupDef[] = [
  {
    id: "research",
    name: "查资料",
    description: "读代码、查资料；多模型独立调查",
    allowCollaborators: true,
    targets: [{ kind: "slot", role: "explorer" }, { kind: "slot", role: "researcher" }],
    fineTune: ["explorer", "researcher"],
  },
  {
    id: "plan",
    name: "想方案",
    description: "出方案、方向裁决；同一节点可多模型独立调查",
    allowCollaborators: true,
    targets: [{ kind: "slot", role: "architect" }, { kind: "direction" }],
    fineTune: ["architect", "direction"],
  },
  {
    id: "code",
    name: "写代码",
    description: "测试、修复、提交；单一写手",
    allowCollaborators: false,
    targets: [{ kind: "slot", role: "worker" }],
    fineTune: ["worker"],
  },
  {
    id: "review",
    name: "做检查",
    description: "不同家族模型复审；同一节点可多模型独立调查",
    allowCollaborators: true,
    targets: [{ kind: "final-review" }],
    fineTune: ["final-review", "verifier"],
  },
];

export const VERIFIER_NOTE = "旧验证角色，已并入审查；细调保留供旧图读取，默认不单独派工。";
export const MIXED_LABEL = "按角色分别设置";
export const NATIVE_SUB_BLOCK = "不支持原生执行/需调整方案框架";
export const SUBAGENT_BLOCK_NOTE = "原生子代理无法表达指定模型或网关时会明确阻断，不会自动改用主控模型或 Worker。跨框架或无法锁定 provider 时标为不可执行并停止，没有 Worker 例外。同框架的精确 provider 仍需运行时核验。";

export function isGroupId(value: string): value is GroupId {
  return (GROUP_IDS as readonly string[]).includes(value);
}

export function groupDef(id: GroupId): GroupDef {
  return GROUPS.find((g) => g.id === id)!;
}

export function routeKey(route: Route): string {
  return `${route.agent}\t${route.model}\t${route.provider_id}\t${route.effort ?? ""}`;
}

export function routesEqual(a: Route | undefined, b: Route | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return routeKey(a) === routeKey(b);
}

export function routeListEqual(a: readonly Route[] = [], b: readonly Route[] = []): boolean {
  if (a.length !== b.length) return false;
  return a.every((route, i) => routesEqual(route, b[i]));
}

export interface TargetRead {
  readonly primary?: Route;
  readonly collaborators: readonly Route[];
  readonly fallbacks: readonly Route[];
  /** direction_gate=lead and no explicit route. */
  readonly directionSelf?: boolean;
  /** final_review_route omitted; resolved value follows architect. */
  readonly sameAsArchitect?: boolean;
}

export interface GroupState {
  readonly id: GroupId;
  readonly mixed: boolean;
  readonly primary?: Route;
  readonly collaborators: readonly Route[];
  readonly directionSelf?: boolean;
  readonly sameAsArchitect?: boolean;
  readonly targets: readonly TargetRead[];
}

function readSlotTarget(manual: ModelManual, profileId: string, taskType: TaskType, role: Role): TargetRead {
  try {
    const resolved = resolve(manual, profileId, taskType, role);
    return {
      primary: resolved.primary,
      collaborators: role === "worker" ? [] : (resolved.collaborators ?? []),
      fallbacks: resolved.fallbacks,
    };
  } catch {
    const profile = manual.profiles.find((p) => p.id === profileId);
    const slot = profile?.nodes[taskType]?.[role] ?? profile?.nodes.default?.[role];
    return {
      primary: slot?.primary,
      collaborators: role === "worker" ? [] : (slot?.collaborators ?? []),
      fallbacks: slot?.fallbacks ?? [],
    };
  }
}

function readDirectionTarget(manual: ModelManual, profileId: string, taskType: TaskType): TargetRead {
  const profile = manual.profiles.find((p) => p.id === profileId);
  if (!profile) return { collaborators: [], fallbacks: [] };
  if (!profile.direction_route && profile.direction_gate !== "astra") {
    return { collaborators: [], fallbacks: [], directionSelf: true };
  }
  if (profile.direction_route) {
    return {
      primary: profile.direction_route,
      collaborators: profile.direction_collaborators ?? [],
      fallbacks: [],
    };
  }
  try {
    const resolved = resolveDirection(manual, profileId, taskType);
    return {
      primary: resolved.primary,
      collaborators: resolved.collaborators ?? [],
      fallbacks: resolved.fallbacks,
    };
  } catch {
    return { collaborators: [], fallbacks: [] };
  }
}

function readFinalReviewTarget(manual: ModelManual, profileId: string, taskType: TaskType): TargetRead {
  const profile = manual.profiles.find((p) => p.id === profileId);
  if (!profile) return { collaborators: [], fallbacks: [] };
  if (!profile.final_review_route) {
    return { collaborators: profile.final_review_collaborators ?? [], fallbacks: [], sameAsArchitect: true };
  }
  try {
    const resolved = resolveFinalReview(manual, profileId, taskType);
    return {
      primary: resolved.primary,
      collaborators: resolved.collaborators ?? [],
      fallbacks: resolved.fallbacks,
    };
  } catch {
    return {
      primary: profile.final_review_route,
      collaborators: profile.final_review_collaborators ?? [],
      fallbacks: [],
    };
  }
}

export function readTarget(manual: ModelManual, profileId: string, taskType: TaskType, target: GroupTarget): TargetRead {
  if (target.kind === "direction") return readDirectionTarget(manual, profileId, taskType);
  if (target.kind === "final-review") return readFinalReviewTarget(manual, profileId, taskType);
  return readSlotTarget(manual, profileId, taskType, target.role);
}

export function readGroupState(manual: ModelManual, profileId: string, taskType: TaskType, groupId: GroupId): GroupState {
  const def = groupDef(groupId);
  const targets = def.targets.map((target) => readTarget(manual, profileId, taskType, target));
  const first = targets[0];
  const mixed = !first || targets.some((t) =>
    t.directionSelf !== first.directionSelf
    || t.sameAsArchitect !== first.sameAsArchitect
    || !routesEqual(t.primary, first.primary)
    || !routeListEqual(t.collaborators, first.collaborators)
  );
  if (mixed) {
    return { id: groupId, mixed: true, collaborators: [], targets };
  }
  return {
    id: groupId,
    mixed: false,
    primary: first.primary,
    collaborators: first.collaborators,
    directionSelf: first.directionSelf,
    sameAsArchitect: first.sameAsArchitect,
    targets,
  };
}

function currentSlot(manual: ModelManual, profileId: string, taskType: TaskType, role: Role): Slot {
  const profile = manual.profiles.find((p) => p.id === profileId);
  return profile?.nodes[taskType]?.[role]
    ?? profile?.nodes.default?.[role]
    ?? { primary: { agent: profile?.harness ?? "codex", model: "", provider_id: "" } };
}

function writeSlot(
  manual: ModelManual,
  profileId: string,
  taskType: TaskType,
  role: Role,
  primary: Route,
  collaborators: readonly Route[] | undefined,
): ModelManual {
  const prev = currentSlot(manual, profileId, taskType, role);
  const primaryUnchanged = routesEqual(prev.primary, primary);
  const next: Slot = {
    primary,
    ...(primaryUnchanged && prev.fallbacks?.length ? { fallbacks: prev.fallbacks } : {}),
    ...(role !== "worker" && collaborators?.length ? { collaborators } : {}),
  };
  return setSlot(manual, profileId, taskType, role, next);
}

function writeTarget(
  manual: ModelManual,
  profileId: string,
  taskType: TaskType,
  target: GroupTarget,
  primary: Route,
  collaborators: readonly Route[] | undefined,
): ModelManual {
  if (target.kind === "direction") {
    const withRoute = setDirectionRoute(manual, profileId, primary);
    return setDirectionCollaborators(withRoute, profileId, collaborators?.length ? collaborators : undefined);
  }
  if (target.kind === "final-review") {
    const withRoute = setFinalReviewRoute(manual, profileId, primary);
    return setFinalReviewCollaborators(withRoute, profileId, collaborators?.length ? collaborators : undefined);
  }
  return writeSlot(manual, profileId, taskType, target.role, primary, collaborators);
}

export function applyGroupClear(
  manual: ModelManual,
  profileId: string,
  groupId: GroupId,
): ModelManual {
  if (groupId !== "review") return manual;
  return setFinalReviewCollaborators(setFinalReviewRoute(manual, profileId, undefined), profileId, undefined);
}

export function applyGroupPrimary(
  manual: ModelManual,
  profileId: string,
  taskType: TaskType,
  groupId: GroupId,
  primary: Route,
): ModelManual {
  const def = groupDef(groupId);
  const state = readGroupState(manual, profileId, taskType, groupId);
  const collaborators = state.mixed || !def.allowCollaborators ? undefined : state.collaborators;
  return def.targets.reduce(
    (next, target) => writeTarget(next, profileId, taskType, target, primary, collaborators),
    manual,
  );
}

export function applyGroupCollaborators(
  manual: ModelManual,
  profileId: string,
  taskType: TaskType,
  groupId: GroupId,
  collaborators: readonly Route[],
): ModelManual {
  const def = groupDef(groupId);
  if (!def.allowCollaborators) return manual;
  const state = readGroupState(manual, profileId, taskType, groupId);
  if (state.mixed || !state.primary) return manual;
  const clipped = collaborators.slice(0, MAX_COLLABORATORS);
  return withSavedVersion(def.targets.reduce(
    (next, target) => writeTarget(next, profileId, taskType, target, state.primary!, clipped),
    manual,
  ));
}

export function addGroupCollaborator(
  manual: ModelManual,
  profileId: string,
  taskType: TaskType,
  groupId: GroupId,
): ModelManual {
  const state = readGroupState(manual, profileId, taskType, groupId);
  if (state.mixed || !state.primary || state.collaborators.length >= MAX_COLLABORATORS) return manual;
  const blank: Route = { agent: state.primary.agent, model: "", provider_id: "" };
  return applyGroupCollaborators(manual, profileId, taskType, groupId, [...state.collaborators, blank]);
}

export function removeGroupCollaborator(
  manual: ModelManual,
  profileId: string,
  taskType: TaskType,
  groupId: GroupId,
  index: number,
): ModelManual {
  const state = readGroupState(manual, profileId, taskType, groupId);
  return applyGroupCollaborators(
    manual,
    profileId,
    taskType,
    groupId,
    state.collaborators.filter((_, i) => i !== index),
  );
}

export function applyRolePrimary(
  manual: ModelManual,
  profileId: string,
  taskType: TaskType,
  role: FineTuneId,
  primary: Route | undefined,
): ModelManual {
  if (role === "direction") return setDirectionRoute(manual, profileId, primary);
  if (role === "final-review") return setFinalReviewRoute(manual, profileId, primary);
  if (!primary) return manual;
  const prev = currentSlot(manual, profileId, taskType, role);
  return writeSlot(manual, profileId, taskType, role, primary, role === "worker" ? undefined : prev.collaborators);
}

export function applyRoleCollaborators(
  manual: ModelManual,
  profileId: string,
  taskType: TaskType,
  role: FineTuneId,
  collaborators: readonly Route[],
): ModelManual {
  if (role === "worker") return manual;
  const next = role === "direction"
    ? setDirectionCollaborators(manual, profileId, collaborators.length ? collaborators : undefined)
    : role === "final-review"
      ? setFinalReviewCollaborators(manual, profileId, collaborators.length ? collaborators : undefined)
      : writeSlot(manual, profileId, taskType, role, currentSlot(manual, profileId, taskType, role).primary, collaborators.length ? collaborators : undefined);
  return collaborators.length ? withSavedVersion(next) : next;
}

export function addRoleCollaborator(
  manual: ModelManual,
  profileId: string,
  taskType: TaskType,
  role: FineTuneId,
): ModelManual {
  if (role === "worker") return manual;
  const read = role === "direction" || role === "final-review"
    ? readTarget(manual, profileId, taskType, { kind: role })
    : readSlotTarget(manual, profileId, taskType, role);
  if (!read.primary?.model || read.collaborators.length >= MAX_COLLABORATORS) return manual;
  const agent = read.primary?.agent ?? manual.profiles.find((p) => p.id === profileId)?.harness ?? "codex";
  const blank: Route = { agent, model: "", provider_id: "" };
  return applyRoleCollaborators(manual, profileId, taskType, role, [...read.collaborators, blank]);
}

export function removeRoleCollaborator(
  manual: ModelManual,
  profileId: string,
  taskType: TaskType,
  role: FineTuneId,
  index: number,
): ModelManual {
  const read = role === "direction" || role === "final-review"
    ? readTarget(manual, profileId, taskType, { kind: role })
    : readSlotTarget(manual, profileId, taskType, role);
  return applyRoleCollaborators(
    manual,
    profileId,
    taskType,
    role,
    read.collaborators.filter((_, i) => i !== index),
  );
}

export function replaceCollaborator(
  list: readonly Route[],
  index: number,
  next: Route,
): Route[] {
  return list.map((route, i) => (i === index ? next : route));
}

export function canAddCollaborator(allow: boolean, mixed: boolean, count: number): boolean {
  return allow && !mixed && count < MAX_COLLABORATORS;
}

/** Family gate uses actual final-review (primary+collaborators), not the retired verifier role. */
export function nativeSubBlockedNote(profileHarness: Harness, routes: readonly Route[]): string | undefined {
  if (routes.some((route) => route.agent && route.agent !== profileHarness)) {
    return `${NATIVE_SUB_BLOCK}。严格原生 sub 不能跨框架，也不会改开 Worker。同框架的精确 provider 仍需运行时核验。`;
  }
}

export function familyConflictNote(manual: ModelManual, profileId: string, taskType: TaskType): string | undefined {
  try {
    const worker = resolve(manual, profileId, taskType, "worker");
    const review = resolveFinalReview(manual, profileId, taskType);
    const wf = family(worker.primary.model);
    const reviewRoutes = [review.primary, ...(review.collaborators ?? [])];
    if (reviewRoutes.some((route) => family(route.model) === wf)) {
      return `终审与写手不能同模型族（写手 ${worker.primary.model}；终审 ${reviewRoutes.map((route) => route.model).join("、")}）。旧验证角色不参与此判断。`;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
