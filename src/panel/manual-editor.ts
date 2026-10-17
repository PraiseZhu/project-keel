// Pure editor logic for the settings-page ModelManual form. DOM stays in settings.ts.

import { resolve } from "../shared/manual/resolve.ts";
import {
  cloneManual,
  DEFAULT_MANUAL,
  exportManual,
  HARNESSES,
  MANUAL_VERSION,
  ManualError,
  MAX_FALLBACKS,
  parseManual,
  ROLES,
  TASK_TYPES,
  type AgentModel,
  type DirectionGate,
  type Harness,
  type ModelManual,
  type Profile,
  type Role,
  type Route,
  type Slot,
  type TaskType,
} from "../shared/manual/schema.ts";
import { validateManual, type ManualIssue } from "../shared/manual/validate.ts";

export const TASK_LABELS: Record<TaskType, string> = {
  default: "默认设置",
  "bug-fix": "修 bug",
  feature: "新功能",
  refactoring: "重构",
  investigation: "调查",
  pr: "PR 推进",
};
export const ROLE_LABELS: Record<Role, string> = {
  explorer: "Explorer",
  researcher: "Researcher",
  worker: "Worker",
  verifier: "Verifier",
  architect: "Architect",
};
export const HARNESS_LABELS: Record<Harness, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  pi: "Pi",
};

export interface SettingsIO {
  getKv(): Promise<Record<string, unknown>>;
  putKv(kv: Record<string, unknown>): Promise<{ ok: boolean; status: number; message?: string }>;
  getAgentModels(): Promise<{ status: number; body?: unknown }>;
  broadcast(message: unknown): void;
}

export interface CatalogState {
  readonly status: "ok" | "upgrade" | "retry" | "error";
  readonly models: readonly AgentModel[];
  readonly message: string;
  readonly retry: boolean;
}

export type SaveResult =
  | { ok: true }
  | { ok: false; kind: "invalid"; issues: ManualIssue[] }
  | { ok: false; kind: "write"; message: string }
  | { ok: false; kind: "conflict"; message: string };

export interface RouteView {
  readonly agent: Harness;
  readonly model: string;
  readonly provider_id: string;
  readonly effort?: string;
  readonly stale?: string;
  readonly modelOptions: readonly { value: string; label: string; hidden: boolean }[];
  readonly effortOptions: readonly { value: string; label: string }[];
}

export interface CellView {
  readonly role: Role;
  readonly taskType: TaskType;
  readonly inherit: boolean;
  readonly primary?: RouteView;
  readonly fallbacks: readonly RouteView[];
  readonly canAddFallback: boolean;
}

export interface ProfileListItem {
  readonly id: string;
  readonly name: string;
  readonly harness: Harness;
  readonly selected: boolean;
  readonly defaultOf?: Harness;
  readonly inheritedBy: readonly string[];
}

export function uniqueProfileId(existing: readonly string[], base = "profile"): string {
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

export function inheritorsOf(manual: ModelManual, id: string): string[] {
  return manual.profiles.filter((p) => p.inherit === id).map((p) => p.name || p.id);
}

export function canDeleteProfile(manual: ModelManual, id: string): { ok: true } | { ok: false; reason: string } {
  const names = inheritorsOf(manual, id);
  if (names.length) return { ok: false, reason: `方案「${id}」被「${names.join("、")}」继承，请先解除继承。` };
  return { ok: true };
}

function patchProfile(manual: ModelManual, id: string, patch: (p: Profile) => Profile): ModelManual {
  return { ...manual, profiles: manual.profiles.map((p) => (p.id === id ? patch(p) : p)) };
}

export function addProfile(manual: ModelManual): { manual: ModelManual; id: string } {
  const id = uniqueProfileId(manual.profiles.map((p) => p.id));
  const hasSol = manual.profiles.some((p) => p.id === "sol");
  const profile: Profile = {
    id,
    name: "新方案",
    harness: "codex",
    lead: { agent: "codex", model: "gpt-6.1-sol", provider_id: "art-cindy", effort: "high" },
    direction_gate: "lead",
    nodes: {},
    ...(hasSol ? { inherit: "sol" } : {}),
  };
  return { manual: { ...manual, profiles: [...manual.profiles, profile] }, id };
}

export function copyProfile(manual: ModelManual, id: string): { manual: ModelManual; id: string } {
  const src = manual.profiles.find((p) => p.id === id);
  if (!src) return { manual, id };
  const nextId = uniqueProfileId(manual.profiles.map((p) => p.id), src.id);
  const copy: Profile = { ...cloneManual({ version: 1, profiles: [src], defaults_by_harness: {} }).profiles[0]!, id: nextId, name: `${src.name} 副本` };
  return { manual: { ...manual, profiles: [...manual.profiles, copy] }, id: nextId };
}

export function deleteProfile(manual: ModelManual, id: string): { manual: ModelManual } | { error: string } {
  const gate = canDeleteProfile(manual, id);
  if (!gate.ok) return { error: gate.reason };
  const defaults: { [H in Harness]?: string } = { ...manual.defaults_by_harness };
  for (const h of HARNESSES) if (defaults[h] === id) delete defaults[h];
  return { manual: { ...manual, profiles: manual.profiles.filter((p) => p.id !== id), defaults_by_harness: defaults } };
}

export function renameProfile(manual: ModelManual, id: string, name: string): ModelManual {
  return patchProfile(manual, id, (p) => ({ ...p, name: name.trim() || p.name }));
}

export function setProfileHarness(manual: ModelManual, id: string, harness: Harness): ModelManual {
  const defaults: { [H in Harness]?: string } = { ...manual.defaults_by_harness };
  for (const h of HARNESSES) if (defaults[h] === id && h !== harness) delete defaults[h];
  return {
    ...patchProfile(manual, id, (p) => ({ ...p, harness, lead: { ...p.lead, agent: harness } })),
    defaults_by_harness: defaults,
  };
}

export function setDirectionGate(manual: ModelManual, id: string, gate: DirectionGate): ModelManual {
  return patchProfile(manual, id, (p) => ({ ...p, direction_gate: gate }));
}

/** undefined = 主控自己定 (gate=lead, drop direction_route and collaborators). Route = gate=astra and store the tuple. */
export function setDirectionRoute(manual: ModelManual, id: string, route?: Route): ModelManual {
  return patchProfile(manual, id, (p) => {
    if (!route) {
      const { direction_route: _drop, direction_collaborators: _collab, ...rest } = p;
      return { ...rest, direction_gate: "lead" };
    }
    return { ...p, direction_gate: "astra", direction_route: route };
  });
}

export function setDirectionCollaborators(manual: ModelManual, id: string, collaborators?: readonly Route[]): ModelManual {
  return patchProfile(manual, id, (p) => {
    if (!collaborators?.length) {
      const { direction_collaborators: _drop, ...rest } = p;
      return rest;
    }
    if (!p.direction_route) return p;
    return { ...p, direction_collaborators: collaborators };
  });
}

export function setLead(manual: ModelManual, id: string, lead: Route): ModelManual {
  return patchProfile(manual, id, (p) => ({ ...p, lead }));
}

/** undefined = 同方案 (drop final_review_route and collaborators). Route = store the tuple on this profile. */
export function setFinalReviewRoute(manual: ModelManual, id: string, route?: Route): ModelManual {
  return patchProfile(manual, id, (p) => {
    if (!route) {
      const { final_review_route: _drop, final_review_collaborators: _collab, ...rest } = p;
      return rest;
    }
    return { ...p, final_review_route: route };
  });
}

export function setFinalReviewCollaborators(manual: ModelManual, id: string, collaborators?: readonly Route[]): ModelManual {
  return patchProfile(manual, id, (p) => {
    if (!collaborators?.length) {
      const { final_review_collaborators: _drop, ...rest } = p;
      return rest;
    }
    if (!p.final_review_route) return p;
    return { ...p, final_review_collaborators: collaborators };
  });
}

export function setInherit(manual: ModelManual, id: string, inherit: string | undefined): ModelManual {
  return patchProfile(manual, id, (p) => {
    if (!inherit) {
      const { inherit: _drop, ...rest } = p;
      return rest;
    }
    return { ...p, inherit };
  });
}

export function setHarnessDefault(manual: ModelManual, profileId: string, on: boolean): ModelManual {
  const profile = manual.profiles.find((p) => p.id === profileId);
  if (!profile) return manual;
  const defaults: { [H in Harness]?: string } = { ...manual.defaults_by_harness };
  if (on) defaults[profile.harness] = profileId;
  else if (defaults[profile.harness] === profileId) delete defaults[profile.harness];
  return { ...manual, defaults_by_harness: defaults };
}

export function setSlot(manual: ModelManual, id: string, taskType: TaskType, role: Role, slot: Slot | undefined): ModelManual {
  return patchProfile(manual, id, (p) => {
    const nodes = { ...p.nodes };
    const col = { ...(nodes[taskType] ?? {}) };
    if (!slot) {
      delete col[role];
      if (!ROLES.some((r) => col[r])) delete nodes[taskType];
      else nodes[taskType] = col;
    } else {
      col[role] = slot;
      nodes[taskType] = col;
    }
    return { ...p, nodes };
  });
}

export function materializeSlot(manual: ModelManual, id: string, taskType: TaskType, role: Role): Slot {
  try {
    const resolved = resolve(manual, id, taskType, role);
    return {
      primary: resolved.primary,
      ...(resolved.fallbacks.length ? { fallbacks: [...resolved.fallbacks] } : {}),
      ...(role !== "worker" && resolved.collaborators?.length ? { collaborators: [...resolved.collaborators] } : {}),
    };
  } catch {
    const harness = manual.profiles.find((p) => p.id === id)?.harness ?? "codex";
    return { primary: { agent: harness, model: "", provider_id: "" } };
  }
}

export function composeKv(existing: Record<string, unknown>, manual: ModelManual): Record<string, unknown> {
  return { ...existing, manual };
}

export function routeFromModel(model: AgentModel, effort?: string): Route {
  const agent = (HARNESSES as readonly string[]).includes(model.agent) ? (model.agent as Harness) : "codex";
  const route: Route = { agent, model: model.id, provider_id: model.providerId };
  const declared = model.efforts && model.efforts.length > 0;
  if (declared && effort && model.efforts!.includes(effort)) return { ...route, effort };
  return route;
}

export function modelKey(model: Pick<AgentModel, "id" | "providerId">): string {
  return `${model.id}\t${model.providerId}`;
}

export function findModel(models: readonly AgentModel[], agent: string, model: string, providerId: string): AgentModel | undefined {
  return models.find((m) => m.agent === agent && m.id === model && m.providerId === providerId);
}

export function filterModels(models: readonly AgentModel[], agent: string, showHidden: boolean): AgentModel[] {
  return models.filter((m) => m.agent === agent && (showHidden || m.visible !== false));
}

export function staleReason(route: Route, models: readonly AgentModel[]): string | undefined {
  if (!route.model || !route.provider_id) return "尚未选择模型。";
  const hit = findModel(models, route.agent, route.model, route.provider_id);
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
    const r = await io.getAgentModels();
    return readCatalog(r.status, r.body);
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
  return JSON.stringify([route.agent, route.model, route.provider_id, route.effort ?? ""]);
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

function routeView(route: Route, models: readonly AgentModel[], showHidden: boolean): RouteView {
  const options = filterModels(models, route.agent, true).map((m) => ({
    value: modelKey(m),
    label: `${m.id} · ${m.providerName ?? m.providerId}`,
    hidden: m.visible === false,
  })).filter((o) => showHidden || !o.hidden || o.value === modelKey({ id: route.model, providerId: route.provider_id }));
  const hit = findModel(models, route.agent, route.model, route.provider_id);
  const effortOptions = [{ value: "", label: "宿主默认" }];
  if (hit?.efforts?.length) for (const e of hit.efforts) effortOptions.push({ value: e, label: e });
  return {
    agent: route.agent,
    model: route.model,
    provider_id: route.provider_id,
    effort: route.effort,
    stale: staleReason(route, models),
    modelOptions: options,
    effortOptions,
  };
}

export function profileList(manual: ModelManual, selectedId: string | undefined): ProfileListItem[] {
  return manual.profiles.map((p) => {
    const defaultOf = HARNESSES.find((h) => manual.defaults_by_harness[h] === p.id);
    return {
      id: p.id,
      name: p.name,
      harness: p.harness,
      selected: p.id === selectedId,
      ...(defaultOf ? { defaultOf } : {}),
      inheritedBy: inheritorsOf(manual, p.id),
    };
  });
}

export function cellView(manual: ModelManual, profileId: string, taskType: TaskType, role: Role, models: readonly AgentModel[], showHidden: boolean): CellView {
  const slot = manual.profiles.find((p) => p.id === profileId)?.nodes[taskType]?.[role];
  if (!slot) return { role, taskType, inherit: true, fallbacks: [], canAddFallback: false };
  const fallbacks = slot.fallbacks ?? [];
  return {
    role,
    taskType,
    inherit: false,
    primary: routeView(slot.primary, models, showHidden),
    fallbacks: fallbacks.map((f) => routeView(f, models, showHidden)),
    canAddFallback: fallbacks.length < MAX_FALLBACKS,
  };
}

export function allCells(manual: ModelManual, profileId: string, models: readonly AgentModel[], showHidden: boolean): CellView[] {
  const out: CellView[] = [];
  for (const role of ROLES) for (const taskType of TASK_TYPES) out.push(cellView(manual, profileId, taskType, role, models, showHidden));
  return out;
}

export function leadView(manual: ModelManual, profileId: string, models: readonly AgentModel[], showHidden: boolean): RouteView | undefined {
  const p = manual.profiles.find((x) => x.id === profileId);
  return p ? routeView(p.lead, models, showHidden) : undefined;
}
