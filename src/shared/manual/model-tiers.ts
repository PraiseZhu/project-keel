// Built-in capability tiers for direction-gate model grouping. Not persisted.

export type ModelTier = 0 | 1 | 2 | 3;

const TOP = [/gpt-6(\.1)?-sol$/, /gpt-6-astra$/, /opus-5(-5)?$/];
const MID = [
  /gpt-6-luna$/,
  /gpt-5\.6-sol$/,
  /grok-4\.[67]$/,
  /glm-5\.3$/,
  /sonnet-5(-5)?$/,
  /kimi-k3$/,
  /qwen3\.[78]-max$/,
  /deepseek-v4-pro$/,
  /gemini-3\.1-pro/,
  /opus-4-[678]$/,
  /mimo-v2\.6-pro$/,
];
const LOW = [/flash|mini|nano|haiku|fast|terra|luna|27b|omni|grok-4\.5|gpt-5\.[45]$|glm-5\.[12]$|kimi-k2|hy\d|mimo|muse|^auto$|sonnet-4/];

function bareModelId(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}

/** 1 strongest, 3 weakest, 0 ungraded. TOP is checked before MID/LOW (luna is MID, not LOW). */
export function modelTier(id: string): ModelTier {
  const s = bareModelId(id);
  if (TOP.some((r) => r.test(s))) return 1;
  if (MID.some((r) => r.test(s))) return 2;
  if (LOW.some((r) => r.test(s))) return 3;
  return 0;
}

export type DirectionGroupKey = "stronger" | "equal" | "ungraded";

export interface DirectionOption {
  readonly agent: string;
  readonly id: string;
  readonly name: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly group: DirectionGroupKey;
}

export interface DirectionGroup {
  readonly key: DirectionGroupKey;
  readonly label: string;
  readonly providerId: string;
  readonly providerLabel: string;
  readonly options: readonly DirectionOption[];
}

export interface DirectionOptionSet {
  readonly groups: readonly DirectionGroup[];
  readonly hiddenWeaker: number;
  readonly stronger: number;
  readonly equal: number;
  readonly ungraded: number;
}

const GROUP_LABEL: Record<DirectionGroupKey, string> = {
  stronger: "比主控强",
  equal: "和主控持平",
  ungraded: "未分级",
};

type ModelRef = { visible?: boolean; agent: string; id: string; providerId: string; name?: string; providerName?: string };

function uniqueVisible(models: readonly ModelRef[], agent: string): ModelRef[] {
  const seen = new Set<string>();
  const out: ModelRef[] = [];
  for (const m of models) {
    if (m.visible !== true || m.agent !== agent) continue;
    const key = `${m.agent}\t${m.id}\t${m.providerId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

/**
 * Classify visible models for the direction row.
 * Unknown lead tier → every candidate is ungraded and hiddenWeaker is 0.
 */
export function directionOptions(
  models: readonly ModelRef[],
  agent: string,
  leadModelId: string,
): DirectionOptionSet {
  const unique = uniqueVisible(models, agent);
  const leadTier = modelTier(leadModelId);
  const buckets: Record<DirectionGroupKey, ModelRef[]> = { stronger: [], equal: [], ungraded: [] };
  let hiddenWeaker = 0;
  for (const m of unique) {
    if (leadTier === 0) {
      buckets.ungraded.push(m);
      continue;
    }
    const t = modelTier(m.id);
    if (t === 0) buckets.ungraded.push(m);
    else if (t < leadTier) buckets.stronger.push(m);
    else if (t === leadTier) buckets.equal.push(m);
    else hiddenWeaker += 1;
  }
  const groups: DirectionGroup[] = [];
  for (const key of ["stronger", "equal", "ungraded"] as const) {
    const byProvider = new Map<string, ModelRef[]>();
    for (const m of buckets[key]) {
      const list = byProvider.get(m.providerId) ?? [];
      list.push(m);
      byProvider.set(m.providerId, list);
    }
    for (const [providerId, list] of byProvider) {
      const providerLabel = list.find((x) => x.providerName)?.providerName ?? providerId;
      groups.push({
        key,
        label: `${GROUP_LABEL[key]} · ${providerLabel}`,
        providerId,
        providerLabel,
        options: list.map((m) => ({
          agent: m.agent,
          id: m.id,
          name: m.name ?? m.id,
          providerId: m.providerId,
          providerName: m.providerName ?? m.providerId,
          group: key,
        })),
      });
    }
  }
  return {
    groups,
    hiddenWeaker,
    stronger: buckets.stronger.length,
    equal: buckets.equal.length,
    ungraded: buckets.ungraded.length,
  };
}
