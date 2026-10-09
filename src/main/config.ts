// Runtime config: read /kv (electron brain is read-only). Empty kv → Appendix C manual
// plus the packed profile's non-model fields. Does not read routing.json.

import { BUILT_PROFILE } from "./context.ts";
import { KeelError, type Host } from "./host.ts";
import { cloneManual, DEFAULT_MANUAL, ManualError, parseManual, type ModelManual } from "../shared/manual/schema.ts";
import { DEFAULT_THRESHOLDS, LANE_PRESETS, type JevThresholds, type KeelProfile, type LaneMatch, type LanePreset } from "../shared/types.ts";

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

/** pr_reply posting mode: "auto" posts directly, "confirm" asks the user per reply. */
export type ReplyConfirm = "auto" | "confirm";
export const DEFAULT_REPLY_CONFIRM: ReplyConfirm = "auto";

export function parseReplyConfirm(raw: unknown): ReplyConfirm {
  if (raw === undefined) return DEFAULT_REPLY_CONFIRM;
  if (raw === "auto" || raw === "confirm") return raw;
  throw new KeelError("REPLY_CONFIG_INVALID", `kv.replyConfirm 只能是 "auto" 或 "confirm"，收到 ${JSON.stringify(raw)}。`);
}

/** Read only kv.replyConfirm so a broken manual elsewhere in /kv cannot block replies. */
export async function loadReplyConfirm(host: Host): Promise<ReplyConfirm> {
  let kv: unknown;
  try {
    kv = await host.kvGet();
  } catch (e) {
    throw new KeelError("KV_READ_FAILED", `读取 /kv 失败：${e instanceof Error ? e.message : String(e)}`);
  }
  const o = kv && typeof kv === "object" && !Array.isArray(kv) ? (kv as Record<string, unknown>) : {};
  return parseReplyConfirm(o.replyConfirm);
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

function isLanePreset(v: unknown): v is LanePreset {
  return typeof v === "string" && Object.hasOwn(LANE_PRESETS, v);
}

function parseLanes(raw: unknown, built: readonly LaneMatch[]): readonly LaneMatch[] {
  if (raw === undefined) return built;
  if (!Array.isArray(raw)) throw new KeelError("LANE_CONFIG_INVALID", "kv.lanes 必须是数组。");
  return raw.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new KeelError("LANE_CONFIG_INVALID", `kv.lanes[${i}] 不是对象。`);
    }
    const o = item as Record<string, unknown>;
    if (typeof o.repo !== "string" || !o.repo.trim()) {
      throw new KeelError("LANE_CONFIG_INVALID", `kv.lanes[${i}] 缺少 repo。`);
    }
    if (!isLanePreset(o.preset)) {
      throw new KeelError("LANE_CONFIG_INVALID", `kv.lanes[${i}] 的 preset 非法。`);
    }
    return {
      repo: o.repo.trim(),
      preset: o.preset,
      ...(typeof o.preflight === "string" && o.preflight ? { preflight: o.preflight } : {}),
      ...(typeof o.verifyCheck === "string" && o.verifyCheck ? { verifyCheck: o.verifyCheck } : {}),
      ...(o.baseRuleFiles && typeof o.baseRuleFiles === "object" && !Array.isArray(o.baseRuleFiles)
        ? { baseRuleFiles: o.baseRuleFiles as LaneMatch["baseRuleFiles"] }
        : {}),
    };
  });
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

  const lanes = parseLanes(kv.lanes, built.lanes);
  const config = { manual, lanes, limits: readLimits(kv.limits), thresholds: readThresholds(kv.thresholds) };
  // Invalidate during this read must not publish stale kv into the new generation.
  if (cacheGen === gen) cache.set(host, { gen, config });
  return config;
}
