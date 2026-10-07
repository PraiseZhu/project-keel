// Runtime config: read /kv (electron brain is read-only). Empty kv → Appendix C manual
// plus the packed profile's non-model fields. Does not read routing.json.

import { BUILT_PROFILE } from "./context.ts";
import { KeelError, type Host } from "./host.ts";
import { cloneManual, DEFAULT_MANUAL, ManualError, parseManual, type ModelManual } from "../shared/manual/schema.ts";
import { DEFAULT_THRESHOLDS, type JevThresholds, type KeelProfile, type LaneMatch } from "../shared/types.ts";

export interface RuntimeLimits {
  readonly concurrentRuns: number;
  readonly inFlightNodesPerRun: number;
  readonly astraBudget: number;
}

export interface RuntimeConfig {
  readonly manual: ModelManual;
  readonly lanes: readonly LaneMatch[];
  readonly limits: RuntimeLimits;
  readonly thresholds: JevThresholds;
}

export const DEFAULT_LIMITS: RuntimeLimits = {
  concurrentRuns: 4,
  inFlightNodesPerRun: 3,
  astraBudget: 4,
};

let cacheGen = 0;
const cache = new WeakMap<Host, { gen: number; config: RuntimeConfig }>();

/** Drop the in-memory RuntimeConfig so the next load re-reads /kv. */
export function invalidateRuntimeConfig(): void {
  cacheGen += 1;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function unitInterval(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function readLimits(raw: unknown): RuntimeLimits {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    concurrentRuns: positiveInt(o.concurrentRuns, DEFAULT_LIMITS.concurrentRuns),
    inFlightNodesPerRun: positiveInt(o.inFlightNodesPerRun, DEFAULT_LIMITS.inFlightNodesPerRun),
    astraBudget: positiveInt(o.astraBudget, DEFAULT_LIMITS.astraBudget),
  };
}

function readThresholds(raw: unknown): JevThresholds {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    act: unitInterval(o.act, DEFAULT_THRESHOLDS.act),
    strict: unitInterval(o.strict, DEFAULT_THRESHOLDS.strict),
  };
}

export async function loadRuntimeConfig(host: Host, built: KeelProfile = BUILT_PROFILE): Promise<RuntimeConfig> {
  const gen = cacheGen;
  const hit = cache.get(host);
  if (hit && hit.gen === gen) return hit.config;
  let kv: Record<string, unknown>;
  try {
    kv = await host.kvGet();
  } catch (e) {
    throw new KeelError("KV_READ_FAILED", `读取 /kv 失败：${e instanceof Error ? e.message : String(e)}`);
  }
  if (!kv || typeof kv !== "object" || Array.isArray(kv)) kv = {};

  let manual: ModelManual;
  if (kv.manual === undefined) {
    manual = cloneManual(DEFAULT_MANUAL);
  } else {
    try {
      manual = parseManual(kv.manual);
    } catch (e) {
      if (e instanceof ManualError) throw new KeelError(e.code, e.message, { path: e.path });
      throw e;
    }
  }

  const lanes = Array.isArray(kv.lanes) ? (kv.lanes as LaneMatch[]) : built.lanes;
  const config = { manual, lanes, limits: readLimits(kv.limits), thresholds: readThresholds(kv.thresholds) };
  // Invalidate during this read must not publish stale kv into the new generation.
  if (cacheGen === gen) cache.set(host, { gen, config });
  return config;
}
