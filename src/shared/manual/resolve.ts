import { ManualError, type Harness, type ModelManual, type Profile, type Role, type Route, type Slot, type TaskType } from "./schema.ts";

export interface ResolvedRoutes {
  readonly primary: Route;
  readonly fallbacks: readonly Route[];
}

function profileById(manual: ModelManual, id: string): Profile | undefined {
  return manual.profiles.find((p) => p.id === id);
}

function lookupSlot(profile: Profile, taskType: TaskType, role: Role): Slot | undefined {
  return profile.nodes[taskType]?.[role] ?? (taskType === "default" ? undefined : profile.nodes.default?.[role]);
}

/**
 * Resolve a slot: nodes[taskType][role] → nodes.default[role] → inherit (same lookup).
 * Throws ManualError on cycles, missing refs, or an unresolvable node.
 */
export function resolve(manual: ModelManual, profileId: string, taskType: TaskType, role: Role): ResolvedRoutes {
  const seen = new Set<string>();
  const walk = (id: string): Slot => {
    if (seen.has(id)) {
      const cycle = [...seen, id].join(" → ");
      throw new ManualError("MANUAL_INHERIT_CYCLE", `主控方案继承形成循环：${cycle}。`, `profiles/${id}/inherit`);
    }
    seen.add(id);
    const profile = profileById(manual, id);
    if (!profile) {
      if (seen.size === 1) throw new ManualError("PROFILE_UNKNOWN", `找不到主控方案 ${id}。`, `profiles/${id}`);
      const from = [...seen][seen.size - 2]!;
      throw new ManualError("MANUAL_INHERIT_MISSING", `方案 ${from} 继承了不存在的方案 ${id}。`, `profiles/${from}/inherit`);
    }
    const own = lookupSlot(profile, taskType, role);
    if (own) return own;
    if (profile.inherit) return walk(profile.inherit);
    throw new ManualError("MANUAL_SLOT_UNRESOLVED", `方案 ${id} 的 ${taskType}/${role} 解析不到节点（无本列、无默认列、无可用继承）。`, `profiles/${id}/nodes/${taskType}/${role}`);
  };
  const slot = walk(profileId);
  return { primary: slot.primary, fallbacks: slot.fallbacks ?? [] };
}

export function resolveProfileForHarness(manual: ModelManual, harness: Harness): Profile {
  const id = manual.defaults_by_harness[harness];
  if (!id) throw new ManualError("PROFILE_HARNESS_DEFAULT_MISSING", `harness ${harness} 没有默认主控方案。`, `defaults_by_harness/${harness}`);
  const profile = profileById(manual, id);
  if (!profile) throw new ManualError("PROFILE_UNKNOWN", `defaults_by_harness.${harness} 引用了不存在的方案 ${id}。`, `defaults_by_harness/${harness}`);
  return profile;
}

export function findProfile(manual: ModelManual, profileId: string): Profile {
  const profile = profileById(manual, profileId);
  if (!profile) throw new ManualError("PROFILE_UNKNOWN", `找不到主控方案 ${profileId}。`, `profiles/${profileId}`);
  return profile;
}
