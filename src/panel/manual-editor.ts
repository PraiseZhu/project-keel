// Pure helpers for the settings page: catalog loading, saving the ModelManual to /kv, import/export. DOM stays in settings.ts.

import {
  cloneManual,
  DEFAULT_MANUAL,
  exportManual,
  HARNESSES,
  isLocalDevice,
  MANUAL_VERSION,
  ManualError,
  parseManual,
  routeDeviceId,
  type AgentModel,
  type Harness,
  type ModelManual,
  type Role,
  type Route,
  type TaskType,
} from "../shared/manual/schema.ts";
import { loadRemoteCatalog } from "../shared/manual/remote-catalog.ts";
import { validateManual, type ManualIssue } from "../shared/manual/validate.ts";

export interface SettingsIO {
  getKv(): Promise<Record<string, unknown>>;
  putKv(kv: Record<string, unknown>): Promise<{ ok: boolean; status: number; message?: string }>;
  getAgentModels(url?: string): Promise<{ status: number; body?: unknown }>;
  broadcast(message: unknown): void;
}

export interface CatalogState {
  readonly status: "ok" | "upgrade" | "retry" | "error";
  readonly models: readonly AgentModel[];
  readonly message: string;
  readonly retry: boolean;
  readonly catalogNote?: string;
}

export type SaveResult =
  | { ok: true }
  | { ok: false; kind: "invalid"; issues: ManualIssue[] }
  | { ok: false; kind: "write"; message: string }
  | { ok: false; kind: "conflict"; message: string };

export function uniqueProfileId(existing: readonly string[], base = "profile"): string {
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

export function composeKv(existing: Record<string, unknown>, manual: ModelManual): Record<string, unknown> {
  return { ...existing, manual };
}

export function routeFromModel(model: AgentModel, effort?: string): Route {
  const agent = (HARNESSES as readonly string[]).includes(model.agent) ? (model.agent as Harness) : "codex";
  const route: Route = {
    agent,
    model: model.id,
    provider_id: model.providerId,
    ...(!isLocalDevice(model.agentDeviceId) ? { agent_device_id: routeDeviceId(model.agentDeviceId) } : {}),
  };
  const declared = model.efforts && model.efforts.length > 0;
  if (declared && effort && model.efforts!.includes(effort)) return { ...route, effort };
  return route;
}

export function findModel(
  models: readonly AgentModel[],
  agent: string,
  model: string,
  providerId: string,
  agentDeviceId?: string | null,
): AgentModel | undefined {
  const want = routeDeviceId(agentDeviceId);
  return models.find((m) => m.agent === agent && m.id === model && m.providerId === providerId
    && routeDeviceId(m.agentDeviceId) === want);
}

export function staleReason(route: Route, models: readonly AgentModel[]): string | undefined {
  if (!route.model || !route.provider_id) return "尚未选择模型。";
  const hit = findModel(models, route.agent, route.model, route.provider_id, route.agent_device_id);
  if (!hit || hit.visible === false) return `模型 ${route.model} 在 agent ${route.agent} / 来源 ${route.provider_id} 下不存在。`;
  if (!hit.efforts || hit.efforts.length === 0) {
    if (route.effort !== undefined) return "该项未声明档位，只接受不填 effort。";
    return undefined;
  }
  if (route.effort !== undefined && !hit.efforts.includes(route.effort)) {
    return `档位 ${route.effort} 不在该项已声明的 efforts（${hit.efforts.join("、")}）内。`;
  }
  return undefined;
}

export function readCatalog(status: number, body: unknown): CatalogState {
  if (status === 404) {
    return { status: "upgrade", models: [], retry: false, message: "请升级 Cindy 后才能读取实时模型清单（/agent-models 返回 404）。" };
  }
  if (status === 503) {
    return { status: "retry", models: [], retry: true, message: "模型清单暂时不可用（503），请稍后重试。" };
  }
  if (status !== 200) {
    return { status: "error", models: [], retry: false, message: `读取模型清单失败（HTTP ${status}）。` };
  }
  const models = body && typeof body === "object" && Array.isArray((body as { models?: unknown }).models)
    ? ((body as { models: AgentModel[] }).models)
    : [];
  return { status: "ok", models, retry: false, message: models.length ? "" : "模型清单为空。" };
}

export async function fetchCatalog(io: SettingsIO): Promise<CatalogState> {
  try {
    const catalog = await loadRemoteCatalog((url) => io.getAgentModels(url));
    const state = catalog.ok ? readCatalog(200, { models: catalog.models }) : readCatalog(catalog.status, { models: catalog.models });
    return catalog.catalogNote ? { ...state, catalogNote: catalog.catalogNote } : state;
  } catch (e) {
    return { status: "error", models: [], retry: false, message: `读取模型清单失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Stable compare key for concurrent-save detection. Invalid stored values keep a raw fingerprint so we never pretend Host CAS. */
export function fingerprintManual(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(parseManual(value));
  } catch {
    try {
      return `raw:${JSON.stringify(value)}`;
    } catch {
      return "raw:unserializable";
    }
  }
}

export function withSavedVersion(manual: ModelManual): ModelManual {
  return manual.version === MANUAL_VERSION ? manual : { ...manual, version: MANUAL_VERSION };
}

export async function loadManualFromKv(io: SettingsIO): Promise<{
  kv: Record<string, unknown>;
  manual: ModelManual;
  error?: string;
  invalid?: boolean;
  fingerprint: string;
}> {
  const kv = await io.getKv();
  if (kv.manual === undefined) return { kv, manual: cloneManual(DEFAULT_MANUAL), fingerprint: "" };
  try {
    const manual = parseManual(kv.manual);
    return { kv, manual, fingerprint: fingerprintManual(manual) };
  } catch (e) {
    const message = e instanceof ManualError ? e.message : "说明书不是合法 JSON。";
    return {
      kv,
      manual: cloneManual(DEFAULT_MANUAL),
      error: message,
      invalid: true,
      fingerprint: fingerprintManual(kv.manual),
    };
  }
}

/** Catalog availability only. Structure, harness defaults, inherit and /kv size always block. */
export function isAvailabilityIssue(issue: ManualIssue): boolean {
  const m = issue.message;
  return m.includes("下不存在") || m.includes("未声明档位") || m.includes("不在该项已声明的 efforts");
}

function routeAtPath(manual: ModelManual, path: string): Route | undefined {
  const parts = path.replace(/\/effort$/, "").split("/");
  if (parts[0] !== "profiles" || !parts[1]) return undefined;
  const profile = manual.profiles.find((p) => p.id === parts[1]);
  if (!profile) return undefined;
  const field = parts[2];
  if (field === "lead") return profile.lead;
  if (field === "direction_route") return profile.direction_route;
  if (field === "final_review_route") return profile.final_review_route;
  if (field === "direction_collaborators" && parts[3] !== undefined) return profile.direction_collaborators?.[Number(parts[3])];
  if (field === "final_review_collaborators" && parts[3] !== undefined) return profile.final_review_collaborators?.[Number(parts[3])];
  if (field === "nodes" && parts[3] && parts[4]) {
    const slot = profile.nodes[parts[3] as TaskType]?.[parts[4] as Role];
    if (!slot) return undefined;
    if (parts[5] === "primary") return slot.primary;
    if (parts[5] === "fallbacks" && parts[6] !== undefined) return slot.fallbacks?.[Number(parts[6])];
    if (parts[5] === "collaborators" && parts[6] !== undefined) return slot.collaborators?.[Number(parts[6])];
  }
}

function routeTuple(route: Route | undefined): string {
  if (!route) return "";
  return JSON.stringify([route.agent, route.model, route.provider_id, route.effort ?? "", routeDeviceId(route.agent_device_id)]);
}

/** Availability issues exempt only when the same route tuple is unchanged. Same error text is not enough. */
export function blockingManualIssues(
  current: readonly ManualIssue[],
  baselineIssues: readonly ManualIssue[],
  currentManual: ModelManual,
  baselineManual: ModelManual,
): ManualIssue[] {
  return current.filter((issue) => {
    if (!isAvailabilityIssue(issue)) return true;
    const prior = baselineIssues.some((b) => b.path === issue.path && b.message === issue.message);
    if (!prior) return true;
    return routeTuple(routeAtPath(currentManual, issue.path)) !== routeTuple(routeAtPath(baselineManual, issue.path));
  });
}

export async function saveManual(
  io: SettingsIO,
  manual: ModelManual,
  models: readonly AgentModel[],
  opts?: { expectedFingerprint?: string; baseline?: ModelManual },
): Promise<SaveResult> {
  const kv = await io.getKv();
  if (opts && "expectedFingerprint" in opts) {
    if (fingerprintManual(kv.manual) !== opts.expectedFingerprint) {
      return {
        ok: false,
        kind: "conflict",
        message: "说明书已被其他面板更新。你的修改仍保留，请重载后再保存。未使用 Host 原子 CAS。",
      };
    }
  }
  const toSave = withSavedVersion(manual);
  const next = composeKv(kv, toSave);
  const issues = validateManual(toSave, models, next);
  const blocking = opts?.baseline
    ? blockingManualIssues(issues, validateManual(opts.baseline, models, composeKv(kv, opts.baseline)), toSave, opts.baseline)
    : issues;
  if (blocking.length) return { ok: false, kind: "invalid", issues: blocking };
  const put = await io.putKv(next);
  if (!put.ok) return { ok: false, kind: "write", message: put.message ?? `写入 /kv 失败（HTTP ${put.status}）。` };
  io.broadcast({ type: "manual-changed" });
  return { ok: true };
}

export function parseImportedJson(text: string): { ok: true; manual: ModelManual } | { ok: false; issues: ManualIssue[] } {
  try {
    return { ok: true, manual: parseManual(JSON.parse(text)) };
  } catch (e) {
    if (e instanceof ManualError) return { ok: false, issues: [{ path: e.path || "", message: e.message }] };
    return { ok: false, issues: [{ path: "", message: "导入内容不是合法 JSON。" }] };
  }
}

export function prettyExport(manual: ModelManual): string {
  return `${JSON.stringify(JSON.parse(exportManual(manual)), null, 2)}\n`;
}
