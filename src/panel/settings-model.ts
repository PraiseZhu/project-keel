// Pure view-data and HTML fragments for the settings model page. Event wiring stays in settings.ts.

import {
  canAddCollaborator,
  familyConflictNote,
  GROUPS,
  MIXED_LABEL,
  nativeSubBlockedNote,
  readGroupState,
  readTarget,
  SUBAGENT_BLOCK_NOTE,
  VERIFIER_NOTE,
  type FineTuneId,
  type GroupId,
} from "./grouped-models.ts";
import { resolve } from "../shared/manual/resolve.ts";
import {
  HARNESSES,
  MAX_COLLABORATORS,
  MAX_FALLBACKS,
  type AgentModel,
  type Harness,
  type ModelManual,
  type Profile,
  type Role,
  type Route,
  type Slot,
  type TaskType,
} from "../shared/manual/schema.ts";
import { findModel, HARNESS_LABELS, materializeSlot, staleReason } from "./manual-editor.ts";

export const SETTINGS_STATUS_IDS = ["jev", "catalog", "hooks", "clock"] as const;
export const SETTINGS_ACCORDION_IDS = ["scope", "jev", "lanes", "advanced"] as const;
export const SETTINGS_ROW_IDS = [
  "lead", "direction", "explorer", "researcher", "worker", "verifier", "architect", "final-review",
  "research", "plan", "code", "review",
] as const;
export type SettingsRowId = (typeof SETTINGS_ROW_IDS)[number];
export type SettingsHarness = "codex" | "claude-code";
export type SettingsTarget = "group" | "role" | "lead";

export const SETTINGS_ROW_META: Record<Exclude<SettingsRowId, GroupId>, { label: string; description: string }> = {
  lead: { label: "主控方案", description: "说明书参考路线，不是当前主会话正在用的模型" },
  direction: { label: "方向裁决", description: "写入 direction_route；同一节点可多模型独立调查" },
  explorer: { label: "探索", description: "读代码找位置" },
  researcher: { label: "研究", description: "查资料、核对接口" },
  worker: { label: "写手", description: "写测试、修复、提交" },
  verifier: { label: "验证", description: VERIFIER_NOTE },
  architect: { label: "方案", description: "出方案、帮写手解卡" },
  "final-review": { label: "审查", description: "不同家族模型复审" },
};

export const TASK_SCOPE_TYPES: readonly Exclude<TaskType, "default">[] = ["bug-fix", "feature", "refactoring", "investigation", "pr"];

export const SESSION_NOTE = "不会改变当前主会话模型";
export { SUBAGENT_BLOCK_NOTE };

export interface ModelOption {
  readonly value: string;
  readonly label: string;
  readonly id: string;
  readonly providerId: string;
}

export interface ModelGroup {
  readonly providerId: string;
  readonly label: string;
  readonly options: readonly ModelOption[];
}

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SelectGroup {
  readonly label: string;
  readonly options: readonly SelectOption[];
}

export interface SelectControl {
  readonly id: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly value: string;
  readonly placeholder?: string;
  readonly options: readonly SelectOption[];
  readonly groups: readonly SelectGroup[];
}

export interface FallbackItemView {
  readonly index: number;
  readonly route: Route;
  readonly stale?: string;
  readonly model: SelectControl;
  readonly effort: SelectControl;
}
export interface FallbackView {
  readonly items: readonly FallbackItemView[];
  readonly canAdd: boolean;
  readonly disabled: boolean;
}

export interface RoutePickView {
  readonly index: number;
  readonly kind: "primary" | "collaborator";
  readonly route?: Route;
  readonly stale?: string;
  readonly model: SelectControl;
  readonly effort: SelectControl;
  readonly filterOpen: boolean;
  readonly query: string;
}

export interface FineTuneView {
  readonly id: FineTuneId | "lead";
  readonly label: string;
  readonly description: string;
  readonly locked: boolean;
  readonly profileLevel: boolean;
  readonly route?: Route;
  readonly stale?: string;
  readonly source?: string;
  readonly directionSelf?: boolean;
  readonly sameAsArchitect?: boolean;
  readonly allowCollaborators: boolean;
  readonly model: SelectControl;
  readonly effort: SelectControl;
  readonly collaborators: readonly RoutePickView[];
  readonly canAddCollaborator: boolean;
  readonly fallbacks?: FallbackView;
  readonly fallbackOpen: boolean;
  readonly filterOpen: boolean;
  readonly query: string;
}

export interface GroupView {
  readonly id: GroupId;
  readonly name: string;
  readonly description: string;
  readonly mixed: boolean;
  readonly allowCollaborators: boolean;
  readonly primary?: RoutePickView;
  readonly collaborators: readonly RoutePickView[];
  readonly canAddCollaborator: boolean;
  readonly directionSelf?: boolean;
  readonly sameAsArchitect?: boolean;
  readonly fineTune: readonly FineTuneView[];
  readonly fineTuneOpen: boolean;
  readonly overrideCount: number;
  readonly familyNote?: string;
  readonly nativeNote?: string;
}

export interface SettingsView {
  readonly harness: SettingsHarness;
  readonly tabs: readonly { id: SettingsHarness; label: string; active: boolean }[];
  readonly profileId?: string;
  readonly profileName?: string;
  readonly empty?: string;
  readonly notice?: string;
  readonly taskType: TaskType;
  readonly taskScope: "all" | "task";
  readonly overrideCount: number;
  readonly statusIds: readonly typeof SETTINGS_STATUS_IDS[number][];
  readonly accordionIds: readonly typeof SETTINGS_ACCORDION_IDS[number][];
  readonly scopeLabel: string;
  readonly sessionNote: string;
  readonly lead?: FineTuneView;
  readonly groups: readonly GroupView[];
}

export interface SettingsUiState {
  readonly fineTuneOpen?: ReadonlySet<string>;
  readonly fallbackOpen?: ReadonlySet<string>;
  readonly filterOpen?: ReadonlySet<string>;
  readonly filterQuery?: ReadonlyMap<string, string>;
}

export function filterKey(row: string, kind: string, index = 0): string {
  return `${row}:${kind}:${index}`;
}

export function unifiedValue(route?: Route): string {
  if (!route?.model || !route.provider_id) return "";
  return JSON.stringify([route.agent, route.model, route.provider_id]);
}

export function parseUnifiedValue(value: string): { agent: Harness; id: string; providerId: string } {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.length >= 3) {
      const agent = (HARNESSES as readonly string[]).includes(String(parsed[0])) ? (parsed[0] as Harness) : "codex";
      return { agent, id: String(parsed[1] ?? ""), providerId: String(parsed[2] ?? "") };
    }
  } catch { /* tab-delimited fallback */ }
  const [agent, id, providerId] = value.split("\t");
  const harness = (HARNESSES as readonly string[]).includes(agent ?? "") ? (agent as Harness) : "codex";
  return { agent: harness, id: id ?? "", providerId: providerId ?? "" };
}

export function isCatalogVisible(model: AgentModel): boolean {
  return model.visible !== false;
}

export function modelTripleKey(agent: string, id: string, providerId: string): string {
  return `${agent}\t${id}\t${providerId}`;
}

export function parseTripleKey(value: string): { agent: string; id: string; providerId: string } {
  const [agent, id, providerId] = value.split("\t");
  return { agent: agent ?? "", id: id ?? "", providerId: providerId ?? "" };
}

export function visibleModels(models: readonly AgentModel[], agent?: string): AgentModel[] {
  return models.filter((m) => isCatalogVisible(m) && (agent === undefined || m.agent === agent));
}

export function groupModelOptions(models: readonly AgentModel[], agent: string): ModelGroup[] {
  const unique = new Map<string, AgentModel>();
  for (const m of visibleModels(models, agent)) {
    const key = `${m.id}\t${m.providerId}`;
    if (!unique.has(key)) unique.set(key, m);
  }
  const byProvider = new Map<string, AgentModel[]>();
  for (const m of unique.values()) {
    const list = byProvider.get(m.providerId) ?? [];
    list.push(m);
    byProvider.set(m.providerId, list);
  }
  return [...byProvider.entries()].map(([providerId, list]) => ({
    providerId,
    label: list.find((x) => x.providerName)?.providerName ?? providerId,
    options: list.map((m) => ({
      value: `${m.id}\t${m.providerId}`,
      label: `${m.name ?? m.id} · ${m.providerName ?? m.providerId}`,
      id: m.id,
      providerId: m.providerId,
    })),
  }));
}

export function acceptCatalogResponse(latestSeq: number, responseSeq: number): boolean {
  return latestSeq === responseSeq;
}

export function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

export function shouldDeferCatalogRender(interacting: boolean): boolean {
  return interacting;
}

export const CATALOG_SELECT_ACTS = ["model", "effort", "collab-model", "collab-effort", "fb-model", "fb-effort"] as const;
export type CatalogSelectAct = (typeof CATALOG_SELECT_ACTS)[number];

export function shouldRefreshCatalogOnOpen(opts: { act: string | null; programmatic: boolean }): boolean {
  if (opts.programmatic) return false;
  return opts.act !== null && (CATALOG_SELECT_ACTS as readonly string[]).includes(opts.act);
}

export type CatalogArrivalAction = "ignore" | "store" | "defer" | "store-and-render";

export function catalogArrivalAction(opts: {
  seqAccepted: boolean;
  interacting: boolean;
  render?: boolean;
}): CatalogArrivalAction {
  if (!opts.seqAccepted) return "ignore";
  if (opts.render === false) return "store";
  if (shouldDeferCatalogRender(opts.interacting)) return "defer";
  return "store-and-render";
}

export function renderOptionHtml(o: SelectOption, selected: string): string {
  return `<option value="${escapeHtml(o.value)}"${o.value === selected ? " selected" : ""}${o.disabled ? " disabled" : ""}>${escapeHtml(o.label)}</option>`;
}

export function renderSelectHtml(
  ctrl: SelectControl,
  row: string,
  act: CatalogSelectAct,
  extra?: { cls?: string; index?: number; target?: SettingsTarget },
): string {
  const groups = ctrl.groups.map((g) => `<optgroup label="${escapeHtml(g.label)}">${g.options.map((o) => renderOptionHtml(o, ctrl.value)).join("")}</optgroup>`).join("");
  const options = ctrl.options.map((o) => renderOptionHtml(o, ctrl.value)).join("");
  const iAttr = extra?.index === undefined ? "" : ` data-i="${extra.index}"`;
  const tAttr = extra?.target ? ` data-target="${extra.target}"` : "";
  return `<select class="${extra?.cls ?? act}" data-act="${act}" data-row="${escapeHtml(row)}"${tAttr}${iAttr} aria-label="${escapeHtml(ctrl.label)}"${ctrl.disabled ? " disabled" : ""}>${options}${groups}</select>`;
}

function effortControl(id: string, route: Route | undefined, hit: AgentModel | undefined, disabled: boolean): SelectControl {
  if (!hit) {
    return {
      id: `${id}-effort`,
      label: "推理强度",
      disabled: true,
      value: route?.effort ?? "",
      placeholder: "未指定",
      options: route?.effort ? [{ value: route.effort, label: route.effort, disabled: true }] : [{ value: "", label: "未指定", disabled: true }],
      groups: [],
    };
  }
  const efforts = hit.efforts && hit.efforts.length > 0 ? hit.efforts : null;
  if (!efforts) {
    return {
      id: `${id}-effort`,
      label: "推理强度",
      disabled: true,
      value: "",
      placeholder: "不声明档位",
      options: [{ value: "", label: "不声明档位", disabled: true }],
      groups: [],
    };
  }
  const options: SelectOption[] = efforts.map((e) => ({ value: e, label: e }));
  if (route?.effort === undefined) {
    return {
      id: `${id}-effort`,
      label: "推理强度",
      disabled,
      value: "",
      placeholder: "未指定",
      options: [{ value: "", label: "未指定" }, ...options],
      groups: [],
    };
  }
  const known = efforts.includes(route.effort);
  return {
    id: `${id}-effort`,
    label: "推理强度",
    disabled,
    value: route.effort,
    options: known ? options : [...options, { value: route.effort, label: `${route.effort}（不支持）` }],
    groups: [],
  };
}

function unifiedModelControl(
  id: string,
  route: Route | undefined,
  models: readonly AgentModel[],
  disabled: boolean,
  extra?: { firstOption?: SelectOption; query?: string },
): SelectControl {
  const selected = unifiedValue(route);
  const q = (extra?.query ?? "").toLocaleLowerCase().trim();
  const byProvider = new Map<string, { label: string; options: SelectOption[] }>();
  for (const m of visibleModels(models)) {
    const agent = (HARNESSES as readonly string[]).includes(m.agent) ? (m.agent as Harness) : m.agent;
    const value = JSON.stringify([m.agent, m.id, m.providerId]);
    const label = `${m.name ?? m.id} · ${m.providerName ?? m.providerId} · ${HARNESS_LABELS[agent as Harness] ?? m.agent}`;
    const hay = `${label} ${m.id} ${m.providerId} ${m.agent} ${m.providerName ?? ""}`.toLocaleLowerCase();
    if (q && !hay.includes(q) && value !== selected) continue;
    const g = byProvider.get(m.providerId) ?? { label: m.providerName ?? m.providerId, options: [] };
    g.options.push({ value, label });
    byProvider.set(m.providerId, g);
  }
  const groups = [...byProvider.values()].map((g) => ({ label: g.label, options: g.options }));
  const options: SelectOption[] = extra?.firstOption ? [extra.firstOption] : [];
  const inGroups = groups.some((g) => g.options.some((o) => o.value === selected));
  if (selected && !inGroups) {
    options.push({
      value: selected,
      label: `${route!.model} · ${route!.provider_id} · ${HARNESS_LABELS[route!.agent] ?? route!.agent}（当前配置不可选）`,
      disabled: true,
    });
  }
  const empty = groups.every((g) => g.options.length === 0) && options.filter((o) => !o.disabled || o.value === extra?.firstOption?.value).length <= (extra?.firstOption ? 1 : 0);
  return {
    id: `${id}-model`,
    label: "模型",
    disabled: disabled || (empty && !extra?.firstOption),
    value: extra?.firstOption && !selected ? extra.firstOption.value : selected,
    placeholder: empty ? "没有可选模型" : undefined,
    options,
    groups,
  };
}

function hitFor(route: Route | undefined, models: readonly AgentModel[]): AgentModel | undefined {
  if (!route?.model || !route.provider_id) return undefined;
  return findModel(models, route.agent, route.model, route.provider_id);
}

function pickView(
  id: string,
  kind: "primary" | "collaborator",
  index: number,
  route: Route | undefined,
  models: readonly AgentModel[],
  disabled: boolean,
  ui: SettingsUiState | undefined,
  firstOption?: SelectOption,
): RoutePickView {
  const key = filterKey(id, kind, index);
  const query = ui?.filterQuery?.get(key) ?? "";
  const hit = hitFor(route, models);
  const visibleHit = hit && isCatalogVisible(hit) ? hit : undefined;
  return {
    index,
    kind,
    route,
    stale: route ? staleReason(route, models) : undefined,
    model: unifiedModelControl(`${id}-${kind}${index}`, route, models, disabled, { firstOption, query }),
    effort: effortControl(`${id}-${kind}${index}`, route, visibleHit ?? hit, disabled || !route?.model),
    filterOpen: ui?.filterOpen?.has(key) === true,
    query,
  };
}

export function editableSlot(manual: ModelManual, profileId: string, taskType: TaskType, role: Role): Slot {
  return manual.profiles.find((p) => p.id === profileId)?.nodes[taskType]?.[role]
    ?? manual.profiles.find((p) => p.id === profileId)?.nodes.default?.[role]
    ?? materializeSlot(manual, profileId, taskType, role);
}

function overrideCount(profile: Profile): number {
  let n = 0;
  for (const t of TASK_SCOPE_TYPES) {
    const col = profile.nodes[t];
    if (!col) continue;
    for (const role of ["explorer", "researcher", "worker", "verifier", "architect"] as const) {
      if (col[role]) n += 1;
    }
  }
  return n;
}

function fallbackView(role: Role, slot: Slot, models: readonly AgentModel[], disabled: boolean): FallbackView {
  const items: FallbackItemView[] = (slot.fallbacks ?? []).map((f, i) => {
    const empty = !f.model || !f.provider_id;
    const hit = findModel(models, f.agent, f.model, f.provider_id);
    const visibleHit = hit && isCatalogVisible(hit) ? hit : undefined;
    const id = `${role}-fb${i}`;
    return {
      index: i,
      route: f,
      stale: staleReason(f, models),
      model: {
        ...unifiedModelControl(id, f, models, disabled, empty
          ? { firstOption: { value: "", label: "选择模型", disabled: true } }
          : undefined),
        label: `第 ${i + 1} 备模型`,
      },
      effort: { ...effortControl(id, f, visibleHit ?? hit, disabled), label: `第 ${i + 1} 备推理强度` },
    };
  });
  return {
    items,
    canAdd: !disabled && items.length < MAX_FALLBACKS,
    disabled,
  };
}

export function pickProfileForHarness(manual: ModelManual, harness: SettingsHarness, profileId?: string): { profile?: Profile; notice?: string; empty?: string } {
  const listed = manual.profiles.filter((p) => p.harness === harness);
  if (profileId) {
    const requested = manual.profiles.find((p) => p.id === profileId);
    if (requested && requested.harness === harness) return { profile: requested };
  }
  const defaultId = manual.defaults_by_harness[harness];
  const def = defaultId ? manual.profiles.find((p) => p.id === defaultId) : undefined;
  if (def && def.harness === harness) return { profile: def };
  if (listed[0]) return { profile: listed[0], notice: `未设 ${HARNESS_LABELS[harness]} 默认方案，正在显示「${listed[0].name}」。` };
  return { empty: `还没有 ${HARNESS_LABELS[harness]} 主控方案。` };
}

function architectName(manual: ModelManual, profile: Profile, taskType: TaskType, models: readonly AgentModel[]): string {
  try {
    const route = resolve(manual, profile.id, taskType, "architect").primary;
    return findModel(models, route.agent, route.model, route.provider_id)?.name ?? route.model;
  } catch {
    return profile.nodes.default?.architect?.primary.model ?? "方案";
  }
}

function leadView(profile: Profile, models: readonly AgentModel[], ui: SettingsUiState | undefined, taskType: TaskType): FineTuneView {
  const route = profile.lead;
  const key = filterKey("lead", "primary", 0);
  const query = ui?.filterQuery?.get(key) ?? "";
  const hit = hitFor(route, models);
  const visibleHit = hit && isCatalogVisible(hit) ? hit : undefined;
  return {
    id: "lead",
    label: SETTINGS_ROW_META.lead.label,
    description: SETTINGS_ROW_META.lead.description,
    locked: false,
    profileLevel: true,
    route,
    stale: staleReason(route, models),
    source: taskType !== "default" ? "所有任务共用" : undefined,
    allowCollaborators: false,
    model: unifiedModelControl("lead", route, models, false, { query }),
    effort: effortControl("lead", route, visibleHit ?? hit, false),
    collaborators: [],
    canAddCollaborator: false,
    fallbackOpen: false,
    filterOpen: ui?.filterOpen?.has(key) === true,
    query,
  };
}

function fineTuneView(
  id: FineTuneId,
  manual: ModelManual,
  profile: Profile,
  taskType: TaskType,
  models: readonly AgentModel[],
  ui: SettingsUiState | undefined,
): FineTuneView {
  const meta = SETTINGS_ROW_META[id];
  const locked = taskType !== "default" && id !== "direction" && id !== "final-review" && !profile.nodes[taskType]?.[id];
  const allowCollaborators = id !== "worker" && id !== "verifier";
  const target = id === "direction" || id === "final-review" ? { kind: id } as const : { kind: "slot" as const, role: id };
  const read = readTarget(manual, profile.id, taskType, target);
  const route = read.primary;
  let source: string | undefined;
  if (taskType !== "default" && id !== "direction" && id !== "final-review" && !profile.nodes[taskType]?.[id]) source = "沿用所有任务";
  else if (taskType === "default" && id !== "direction" && id !== "final-review" && !profile.nodes.default?.[id] && profile.inherit) {
    source = `继承自 ${profile.inherit}`;
  }
  if (taskType !== "default" && (id === "direction" || id === "final-review")) source = "所有任务共用";
  const firstOption = read.directionSelf
    ? { value: "", label: "主控自己定" }
    : read.sameAsArchitect
      ? { value: "", label: `同方案 · ${architectName(manual, profile, taskType, models)}` }
      : undefined;
  const key = filterKey(id, "primary", 0);
  const query = ui?.filterQuery?.get(key) ?? "";
  const hit = hitFor(route, models);
  const visibleHit = hit && isCatalogVisible(hit) ? hit : undefined;
  const collabs = allowCollaborators
    ? read.collaborators.map((c, i) => pickView(id, "collaborator", i, c, models, locked, ui, !c.model ? { value: "", label: "选择模型", disabled: true } : undefined))
    : [];
  const slotRole = id === "direction" || id === "final-review" ? undefined : id;
  return {
    id,
    label: meta.label,
    description: meta.description,
    locked,
    profileLevel: id === "direction" || id === "final-review",
    route,
    stale: route ? staleReason(route, models) : undefined,
    source,
    directionSelf: read.directionSelf,
    sameAsArchitect: read.sameAsArchitect,
    allowCollaborators,
    model: unifiedModelControl(id, read.directionSelf || read.sameAsArchitect ? undefined : route, models, locked, { firstOption, query }),
    effort: effortControl(id, read.directionSelf ? undefined : route, visibleHit ?? hit, locked || !!read.directionSelf || (!!read.sameAsArchitect && !profile.final_review_route)),
    collaborators: collabs,
    canAddCollaborator: canAddCollaborator(allowCollaborators, false, collabs.length) && !locked,
    fallbacks: slotRole ? fallbackView(slotRole, editableSlot(manual, profile.id, taskType, slotRole), models, locked) : undefined,
    fallbackOpen: slotRole ? ui?.fallbackOpen?.has(slotRole) === true : false,
    filterOpen: ui?.filterOpen?.has(key) === true,
    query,
  };
}

function groupView(
  groupId: GroupId,
  manual: ModelManual,
  profile: Profile,
  taskType: TaskType,
  models: readonly AgentModel[],
  ui: SettingsUiState | undefined,
): GroupView {
  const def = GROUPS.find((g) => g.id === groupId)!;
  const state = readGroupState(manual, profile.id, taskType, groupId);
  const firstOption = state.mixed
    ? { value: "", label: MIXED_LABEL, disabled: true }
    : state.sameAsArchitect
      ? { value: "", label: `同方案 · ${architectName(manual, profile, taskType, models)}` }
      : state.directionSelf
        ? { value: "", label: "主控自己定" }
        : undefined;
  const displayRoute = state.mixed || state.sameAsArchitect || state.directionSelf ? undefined : state.primary;
  const primary = pickView(groupId, "primary", 0, displayRoute, models, false, ui, firstOption);
  const collabs = !state.mixed && def.allowCollaborators
    ? state.collaborators.map((c, i) => pickView(groupId, "collaborator", i, c, models, false, ui, !c.model ? { value: "", label: "选择模型", disabled: true } : undefined))
    : [];
  const fineTune = def.fineTune.map((id) => fineTuneView(id, manual, profile, taskType, models, ui));
  return {
    id: groupId,
    name: def.name,
    description: def.description,
    mixed: state.mixed,
    allowCollaborators: def.allowCollaborators,
    primary,
    collaborators: collabs,
    canAddCollaborator: canAddCollaborator(def.allowCollaborators, state.mixed, collabs.length),
    directionSelf: state.directionSelf,
    sameAsArchitect: state.sameAsArchitect,
    fineTune,
    fineTuneOpen: ui?.fineTuneOpen?.has(groupId) === true,
    overrideCount: fineTune.filter((r) => !r.locked && taskType !== "default" && !r.profileLevel).length,
    familyNote: groupId === "review" || groupId === "code" ? familyConflictNote(manual, profile.id, taskType) : undefined,
    nativeNote: def.allowCollaborators
      ? nativeSubBlockedNote(profile.harness, state.targets.flatMap((t) => [t.primary, ...t.collaborators].filter((r): r is Route => !!r)))
      : undefined,
  };
}

export function buildSettingsView(
  manual: ModelManual,
  sel: { harness: SettingsHarness; profileId?: string; taskType: TaskType },
  catalog: readonly AgentModel[],
  ui?: SettingsUiState,
): SettingsView {
  const taskType: TaskType = sel.taskType;
  const taskScope: "all" | "task" = taskType === "default" ? "all" : "task";
  const picked = pickProfileForHarness(manual, sel.harness, sel.profileId);
  const tabs = [
    { id: "codex" as const, label: "Codex 方案", active: sel.harness === "codex" },
    { id: "claude-code" as const, label: "Claude Code 方案", active: sel.harness === "claude-code" },
  ];
  const base = {
    harness: sel.harness,
    tabs,
    taskType,
    taskScope,
    statusIds: SETTINGS_STATUS_IDS,
    accordionIds: SETTINGS_ACCORDION_IDS,
    sessionNote: SESSION_NOTE,
  };
  if (!picked.profile) {
    return { ...base, empty: picked.empty, overrideCount: 0, scopeLabel: `${HARNESS_LABELS[sel.harness]} · 无方案`, groups: [] };
  }
  const profile = picked.profile;
  const overrides = overrideCount(profile);
  const fromTask = taskType === "default"
    ? (overrides ? `默认设置（保留 ${overrides} 处任务专属覆盖）` : "默认设置")
    : { "bug-fix": "修 bug", feature: "新功能", refactoring: "重构", investigation: "调查", pr: "PR 推进" }[taskType];
  const scopeLabel = `${profile.name} · ${HARNESS_LABELS[profile.harness]} · ${fromTask}`;
  return {
    ...base,
    profileId: profile.id,
    profileName: profile.name,
    notice: picked.notice,
    overrideCount: overrideCount(profile),
    scopeLabel,
    lead: leadView(profile, catalog, ui, taskType),
    groups: GROUPS.map((g) => groupView(g.id, manual, profile, taskType, catalog, ui)),
  };
}

function renderFilter(row: string, kind: string, index: number, open: boolean, query: string, target: SettingsTarget, label: string): { search: string; btn: string } {
  const keyAttrs = `data-row="${escapeHtml(row)}" data-kind="${kind}" data-i="${index}" data-target="${target}"`;
  const search = `<input type="search" data-act="search" ${keyAttrs} placeholder="搜索模型、网关、框架" aria-label="${escapeHtml(label)}：搜索模型"${open ? "" : " hidden"} value="${escapeHtml(query)}">`;
  const btn = `<button type="button" class="filter-model" data-act="filter" ${keyAttrs} aria-label="${escapeHtml(label)}：筛选模型" aria-expanded="${open}">筛选</button>`;
  return { search, btn };
}

function mixedPick(): RoutePickView {
  return {
    index: 0,
    kind: "primary",
    model: {
      id: "mixed-model",
      label: "模型",
      disabled: false,
      value: "",
      options: [{ value: "", label: MIXED_LABEL, disabled: true }],
      groups: [],
    },
    effort: {
      id: "mixed-effort",
      label: "推理强度",
      disabled: true,
      value: "",
      options: [{ value: "", label: "未指定", disabled: true }],
      groups: [],
    },
    filterOpen: false,
    query: "",
  };
}

function renderRoutePick(
  row: string,
  target: SettingsTarget,
  pick: RoutePickView,
  opts?: { removable?: boolean; firstAct?: CatalogSelectAct; effortAct?: CatalogSelectAct },
): string {
  const modelAct = opts?.firstAct ?? (pick.kind === "collaborator" ? "collab-model" : "model");
  const effortAct = opts?.effortAct ?? (pick.kind === "collaborator" ? "collab-effort" : "effort");
  const filter = renderFilter(row, pick.kind, pick.index, pick.filterOpen, pick.query, target, pick.model.label);
  const remove = opts?.removable
    ? `<button type="button" class="remove-model" data-act="del-collab" data-row="${escapeHtml(row)}" data-target="${target}" data-i="${pick.index}" title="移除此模型" aria-label="移除协作模型">×</button>`
    : "";
  const status = pick.stale ? `<span class="route-status bad">${escapeHtml(pick.stale)}</span>` : `<span class="route-status"></span>`;
  return `<div class="route-controls${pick.stale ? " stale" : ""}">
    ${filter.search}
    <div class="route-pick${opts?.removable ? " removable" : ""}">
      ${renderSelectHtml(pick.model, row, modelAct, { cls: "model", index: pick.index, target })}
      ${renderSelectHtml(pick.effort, row, effortAct, { index: pick.index, target })}
      ${filter.btn}
      ${remove}
    </div>
    ${status}
  </div>`;
}

function renderFallbackPanel(row: FineTuneView): string {
  if (!row.fallbacks) return "";
  const r = escapeHtml(row.id);
  const { items, canAdd, disabled } = row.fallbacks;
  const full = items.length >= MAX_FALLBACKS;
  const itemHtml = items.map((it) => {
    return `<div class="fb-item${it.stale ? " stale" : ""}"${it.stale ? ` title="${escapeHtml(it.stale)}"` : ""}>
      <span class="ord">第 ${it.index + 1} 备</span>
      ${renderSelectHtml(it.model, row.id, "fb-model", { cls: "model", index: it.index, target: "role" })}
      ${renderSelectHtml(it.effort, row.id, "fb-effort", { index: it.index, target: "role" })}
      <button type="button" class="icon-btn" data-act="del-fb" data-row="${r}" data-i="${it.index}" title="移除这条备用" aria-label="移除第 ${it.index + 1} 备"${disabled ? " disabled" : ""}>×</button>
    </div>`;
  }).join("");
  return `<div class="fb-panel" id="fb-panel-${r}"${row.fallbackOpen ? "" : ""}>
     <div class="fb-head"><b>故障备选</b><span>${disabled ? "沿用所有任务；点「单独设置」后可改" : "主模型用不了时按顺序换用，不是协作。改主模型或推理强度会清空旧备选，保存后生效。"}</span></div>
     ${itemHtml}
     <button type="button" class="fb-add" data-act="add-fb" data-row="${r}"${canAdd ? "" : " disabled"}>＋ 添加备用${full ? `（已满 ${MAX_FALLBACKS} 条）` : ""}</button>
   </div>`;
}

function renderFineTune(row: FineTuneView, taskType: TaskType): string {
  const primary: RoutePickView = {
    index: 0,
    kind: "primary",
    route: row.route,
    stale: row.stale,
    model: row.model,
    effort: row.effort,
    filterOpen: row.filterOpen,
    query: row.query,
  };
  let sub = row.source ? escapeHtml(row.source) : "";
  if (row.stale) sub = (sub ? `${sub} · ` : "") + `<span class="stale-reason">${escapeHtml(row.stale)}</span>`;
  if (row.locked) sub = `沿用所有任务 · <button type="button" class="link" data-act="own" data-row="${escapeHtml(row.id)}">单独设置</button>`;
  else if (taskType !== "default" && !row.profileLevel && !row.locked) {
    sub = (sub ? `${sub} · ` : "") + `<button type="button" class="link" data-act="inherit-slot" data-row="${escapeHtml(row.id)}">改回沿用所有任务</button>`;
  }
  const collabHtml = row.collaborators.map((c) => renderRoutePick(row.id, "role", c, { removable: true })).join("");
  const add = row.canAddCollaborator
    ? `<button type="button" class="add-model" data-act="add-collab" data-row="${escapeHtml(row.id)}" data-target="role">+ 添加协作模型</button>`
    : "";
  const fbChip = row.fallbacks
    ? `<button type="button" class="fb-chip${row.fallbacks.items.length ? "" : " empty"}" data-act="toggle-fb" data-row="${escapeHtml(row.id)}" aria-expanded="${row.fallbackOpen}">${row.fallbacks.items.length ? `备用<span class="n">${row.fallbacks.items.length}</span>` : "＋ 备用"}</button>`
    : "";
  return `<div class="role-editor${row.locked ? " locked" : ""}${row.stale ? " stale" : ""}${row.fallbackOpen ? " open" : ""}" data-row="${escapeHtml(row.id)}">
    <div class="role-title"><strong>${escapeHtml(row.label)}</strong><code class="muted">${escapeHtml(row.id)}</code></div>
    <p class="muted">${escapeHtml(row.description)}</p>
    ${renderRoutePick(row.id, "role", primary)}
    ${collabHtml}
    ${add}
    ${fbChip}
    ${row.fallbackOpen ? renderFallbackPanel(row) : renderFallbackPanel(row)}
    ${sub ? `<div class="sub">${sub}</div>` : ""}
  </div>`;
}

export function renderLeadHtml(lead: FineTuneView): string {
  const primary: RoutePickView = {
    index: 0,
    kind: "primary",
    route: lead.route,
    stale: lead.stale,
    model: lead.model,
    effort: lead.effort,
    filterOpen: lead.filterOpen,
    query: lead.query,
  };
  return `<div class="lead-editor${lead.stale ? " stale" : ""}">
    <div class="group-title"><h3>${escapeHtml(lead.label)}</h3><p class="muted">${escapeHtml(lead.description)}</p></div>
    ${renderRoutePick("lead", "lead", primary)}
    ${lead.stale ? `<p class="route-status bad">${escapeHtml(lead.stale)}</p>` : ""}
  </div>`;
}

export function renderGroupHtml(group: GroupView, taskType: TaskType): string {
  const collabHtml = group.collaborators.map((c) => renderRoutePick(group.id, "group", c, { removable: true })).join("");
  const add = group.canAddCollaborator
    ? `<button type="button" class="add-model" data-act="add-collab" data-row="${escapeHtml(group.id)}" data-target="group">+ 添加协作模型</button>`
    : "";
  const mixedNote = group.mixed ? `<p class="mixed">${MIXED_LABEL}</p>` : "";
  const familyNote = group.familyNote ? `<p class="mixed">${escapeHtml(group.familyNote)}</p>` : "";
  const nativeNote = group.nativeNote ? `<p class="mixed native-block">${escapeHtml(group.nativeNote)}</p>` : "";
  const count = group.fineTune.length;
  const details = `<details data-group="${escapeHtml(group.id)}"${group.fineTuneOpen ? " open" : ""}>
    <summary><span>角色细调</span><span class="detail-count">${count} 个角色</span></summary>
    ${group.fineTune.map((row) => renderFineTune(row, taskType)).join("")}
  </details>`;
  return `<section class="model-group" data-group-id="${escapeHtml(group.id)}">
    <div class="group-title"><h3>${escapeHtml(group.name)}</h3><p class="muted">${escapeHtml(group.description)}</p></div>
    <div class="choice-controls">
      ${mixedNote}
      ${familyNote}
      ${nativeNote}
      ${renderRoutePick(group.id, "group", group.primary ?? mixedPick(), {})}
      ${collabHtml}
      ${add}
      ${details}
    </div>
  </section>`;
}

export function renderGroupsHtml(groups: readonly GroupView[], taskType: TaskType): string {
  return groups.map((g) => renderGroupHtml(g, taskType)).join("");
}

export function renderProfileButtonHtml(p: { id: string; name: string; selected?: boolean; defaultOf?: Harness }): string {
  return `<button type="button" data-act="select" data-id="${escapeHtml(p.id)}"${p.selected ? " class=\"on\"" : ""}>${escapeHtml(p.name)}${p.defaultOf ? ` · ${HARNESS_LABELS[p.defaultOf]}默认` : ""}</button>`;
}

export function renderInheritOptionHtml(p: { id: string; name: string }, selectedId?: string): string {
  return `<option value="${escapeHtml(p.id)}"${selectedId === p.id ? " selected" : ""}>${escapeHtml(p.name)}</option>`;
}

export function routeAfterAgentChange(models: readonly AgentModel[], agent: Harness, prevEffort?: string): Route {
  const first = visibleModels(models, agent)[0];
  return first ? routeFromVisible(first, prevEffort) : { agent, model: "", provider_id: "" };
}

function routeFromVisible(model: AgentModel, effort?: string): Route {
  const agent = (HARNESSES as readonly string[]).includes(model.agent) ? (model.agent as Harness) : "codex";
  const route: Route = { agent, model: model.id, provider_id: model.providerId };
  const declared = model.efforts && model.efforts.length > 0;
  if (declared && effort && model.efforts!.includes(effort)) return { ...route, effort };
  return route;
}

export function routeAfterModelChange(models: readonly AgentModel[], agent: Harness, modelId: string, providerId: string, prevEffort?: string): Route {
  const hit = findModel(models, agent, modelId, providerId);
  return hit ? routeFromVisible(hit, prevEffort) : { agent, model: modelId, provider_id: providerId };
}

export function routeAfterUnifiedChange(models: readonly AgentModel[], value: string, prevEffort?: string): Route {
  const parsed = parseUnifiedValue(value);
  if (!parsed.id || !parsed.providerId) return { agent: parsed.agent, model: "", provider_id: "" };
  return routeAfterModelChange(models, parsed.agent, parsed.id, parsed.providerId, prevEffort);
}

export function routeAfterEffortChange(models: readonly AgentModel[], current: Route, effort: string): Route {
  const hit = findModel(models, current.agent, current.model, current.provider_id);
  if (hit) return routeFromVisible(hit, effort || undefined);
  if (!effort) {
    const { effort: _drop, ...rest } = current;
    return rest;
  }
  return { ...current, effort };
}

export { materializeSlot };
