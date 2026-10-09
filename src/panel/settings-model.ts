// Pure view-data and HTML fragments for the settings model page. Event wiring stays in settings.ts.

import { resolve, resolveDirection } from "../shared/manual/resolve.ts";
import { directionOptions } from "../shared/manual/model-tiers.ts";
import {
  HARNESSES,
  ROLES,
  TASK_TYPES,
  type AgentModel,
  type Harness,
  type ModelManual,
  type Profile,
  type Role,
  type Route,
  type Slot,
  type TaskType,
} from "../shared/manual/schema.ts";
import { findModel, HARNESS_LABELS, materializeSlot, routeFromModel, staleReason } from "./manual-editor.ts";

export const SETTINGS_STATUS_IDS = ["jev", "catalog", "hooks", "clock"] as const;
export const SETTINGS_ACCORDION_IDS = ["jev", "lanes", "advanced"] as const;
export const SETTINGS_ROW_IDS = ["lead", "direction", "explorer", "researcher", "worker", "verifier", "architect"] as const;
export type SettingsRowId = (typeof SETTINGS_ROW_IDS)[number];
export type SettingsHarness = "codex" | "claude-code";

export const SETTINGS_ROW_META: Record<SettingsRowId, { label: string; description: string }> = {
  lead: { label: "主控", description: "发起并推进整件事" },
  direction: { label: "方向裁决", description: "选路线时谁拍板" },
  explorer: { label: "探索", description: "读代码，找要改的位置" },
  researcher: { label: "研究", description: "查资料、核对接口" },
  worker: { label: "实现", description: "复现、写代码、提交" },
  verifier: { label: "验证", description: "换一个模型复核" },
  architect: { label: "方案与终审", description: "定方案、最终审查" },
};

export const TASK_SCOPE_TYPES: readonly Exclude<TaskType, "default">[] = ["bug-fix", "feature", "refactoring", "investigation", "pr"];

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

export interface SettingsRowView {
  readonly id: SettingsRowId;
  readonly label: string;
  readonly description: string;
  readonly lead: boolean;
  readonly route?: Route;
  readonly source?: string;
  readonly stale?: string;
  readonly locked: boolean;
  readonly profileLevel: boolean;
  readonly directionSelf: boolean;
  readonly hiddenWeaker?: number;
  readonly stronger?: number;
  readonly equal?: number;
  readonly agent: SelectControl;
  readonly model: SelectControl;
  readonly effort: SelectControl;
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
  readonly rowIds: readonly SettingsRowId[];
  readonly rows: readonly SettingsRowView[];
}

export function modelTripleKey(agent: string, id: string, providerId: string): string {
  return `${agent}\t${id}\t${providerId}`;
}

export function parseTripleKey(value: string): { agent: string; id: string; providerId: string } {
  const [agent, id, providerId] = value.split("\t");
  return { agent: agent ?? "", id: id ?? "", providerId: providerId ?? "" };
}

export function visibleModels(models: readonly AgentModel[], agent?: string): AgentModel[] {
  return models.filter((m) => m.visible === true && (agent === undefined || m.agent === agent));
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

/** True when a catalog refresh must not rebuild the select the user is operating. */
export function shouldDeferCatalogRender(interacting: boolean): boolean {
  return interacting;
}

/** Ignore programmatic focus after a rebuild so it cannot restart the catalog refresh loop. */
export function shouldRefreshCatalogOnOpen(opts: { act: string | null; programmatic: boolean }): boolean {
  if (opts.programmatic) return false;
  return opts.act === "model" || opts.act === "effort" || opts.act === "agent";
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

export function renderSelectHtml(ctrl: SelectControl, row: SettingsRowId, act: "agent" | "model" | "effort", cls?: string): string {
  const groups = ctrl.groups.map((g) => `<optgroup label="${escapeHtml(g.label)}">${g.options.map((o) => renderOptionHtml(o, ctrl.value)).join("")}</optgroup>`).join("");
  const options = ctrl.options.map((o) => renderOptionHtml(o, ctrl.value)).join("");
  return `<select class="${cls ?? act}" data-act="${act}" data-row="${escapeHtml(row)}" aria-label="${escapeHtml(ctrl.label)}"${ctrl.disabled ? " disabled" : ""}>${options}${groups}</select>`;
}

export function renderRowHtml(row: SettingsRowView, taskType: TaskType): string {
  const locked = row.locked ? " style=\"opacity:.45\"" : "";
  const pick = `<div class="pick"${locked}>${renderSelectHtml(row.agent, row.id, "agent")}${renderSelectHtml(row.model, row.id, "model", "model")}${renderSelectHtml(row.effort, row.id, "effort")}</div>`;
  let sub = row.source ? escapeHtml(row.source) : "";
  if (row.stale) sub = (sub ? `${sub} · ` : "") + `<span class="stale-reason">${escapeHtml(row.stale)}</span>`;
  if (row.locked) sub = `沿用所有任务的设置 · <button type="button" class="link" data-act="own" data-row="${escapeHtml(row.id)}">单独设置</button>`;
  else if (taskType !== "default" && !row.profileLevel && SETTINGS_ROW_IDS.includes(row.id)) {
    sub = (sub ? `${sub} · ` : "") + `<button type="button" class="link" data-act="inherit-slot" data-row="${escapeHtml(row.id)}">沿用所有任务</button>`;
  }
  return `<div class="row${row.lead ? " lead" : ""}${row.stale ? " stale" : ""}"><div class="role"><b>${escapeHtml(row.label)}</b><span>${escapeHtml(row.description)}</span></div>${pick}${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;
}

export function renderProfileButtonHtml(p: { id: string; name: string; selected?: boolean; defaultOf?: Harness }): string {
  return `<button type="button" data-act="select" data-id="${escapeHtml(p.id)}"${p.selected ? " class=\"on\"" : ""}>${escapeHtml(p.name)}${p.defaultOf ? ` · ${HARNESS_LABELS[p.defaultOf]}默认` : ""}</button>`;
}

export function renderInheritOptionHtml(p: { id: string; name: string }, selectedId?: string): string {
  return `<option value="${escapeHtml(p.id)}"${selectedId === p.id ? " selected" : ""}>${escapeHtml(p.name)}</option>`;
}

function agentControl(id: string, value: Harness, disabled: boolean): SelectControl {
  return {
    id: `${id}-agent`,
    label: "运行环境",
    disabled,
    value,
    options: HARNESSES.map((h) => ({ value: h, label: HARNESS_LABELS[h] })),
    groups: [],
  };
}

function effortControl(id: string, route: Route | undefined, hit: AgentModel | undefined, disabled: boolean): SelectControl {
  if (!hit) {
    return {
      id: `${id}-effort`,
      label: "档位",
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
      label: "档位",
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
      label: "档位",
      disabled,
      value: "",
      placeholder: "未指定",
      options: [{ value: "", label: "未指定", disabled: true }, ...options],
      groups: [],
    };
  }
  return {
    id: `${id}-effort`,
    label: "档位",
    disabled,
    value: route.effort,
    options,
    groups: [],
  };
}

function modelControl(
  id: string,
  route: Route | undefined,
  models: readonly AgentModel[],
  disabled: boolean,
  extra?: { firstOption?: SelectOption; groups?: SelectGroup[]; placeholder?: string },
): SelectControl {
  const groups: SelectGroup[] = extra?.groups ?? groupModelOptions(models, route?.agent ?? "codex").map((g) => ({
    label: g.label,
    options: g.options.map((o) => ({ value: o.value, label: o.label })),
  }));
  const value = route?.model && route.provider_id ? `${route.model}\t${route.provider_id}` : "";
  const inGroups = groups.some((g) => g.options.some((o) => o.value === value && !o.disabled));
  const options: SelectOption[] = extra?.firstOption ? [extra.firstOption] : [];
  if (value && !inGroups && extra?.firstOption?.value !== value) {
    options.push({ value, label: `${route!.model} · ${route!.provider_id}（当前配置不可选）`, disabled: true });
  }
  const empty = groups.every((g) => g.options.length === 0) && options.filter((o) => !o.disabled || o.value === extra?.firstOption?.value).length <= (extra?.firstOption ? 1 : 0);
  return {
    id: `${id}-model`,
    label: "模型",
    disabled: disabled || (empty && !extra?.firstOption),
    value: extra?.firstOption && !value ? extra.firstOption.value : value,
    placeholder: extra?.placeholder ?? (empty ? "没有可选模型" : undefined),
    options,
    groups,
  };
}

function ownSlot(profile: Profile, taskType: TaskType, role: Role): Slot | undefined {
  return profile.nodes[taskType]?.[role] ?? (taskType === "default" ? undefined : undefined);
}

function overrideCount(profile: Profile): number {
  let n = 0;
  for (const t of TASK_SCOPE_TYPES) {
    const col = profile.nodes[t];
    if (!col) continue;
    for (const role of ROLES) if (col[role]) n += 1;
  }
  return n;
}

function fallbackNote(slot: Slot | undefined): string | undefined {
  const fbs = slot?.fallbacks ?? [];
  if (!fbs.length) return undefined;
  return `备用：${fbs.map((f) => `${HARNESS_LABELS[f.agent]} · ${f.model} · ${f.provider_id}`).join("；")}`;
}

function roleRow(
  id: Role,
  manual: ModelManual,
  profile: Profile,
  taskType: TaskType,
  models: readonly AgentModel[],
): SettingsRowView {
  const locked = taskType !== "default" && !profile.nodes[taskType]?.[id];
  let route: Route | undefined;
  let source: string | undefined;
  try {
    route = resolve(manual, profile.id, taskType, id).primary;
  } catch {
    route = profile.nodes.default?.[id]?.primary;
  }
  const own = ownSlot(profile, taskType === "default" ? "default" : taskType, id) ?? (taskType === "default" ? profile.nodes.default?.[id] : profile.nodes[taskType]?.[id]);
  if (taskType !== "default" && !profile.nodes[taskType]?.[id]) source = "沿用所有任务的设置";
  else if (taskType === "default" && !profile.nodes.default?.[id] && profile.inherit) source = `继承自 ${profile.inherit}`;
  const fb = fallbackNote(own ?? (taskType === "default" ? undefined : profile.nodes.default?.[id]));
  if (fb) source = source ? `${source} · ${fb}` : fb;
  const agent = (route?.agent ?? profile.harness) as Harness;
  const effective: Route | undefined = route ?? (agent ? { agent, model: "", provider_id: "" } : undefined);
  const hit = effective ? findModel(models, effective.agent, effective.model, effective.provider_id) : undefined;
  const stale = effective ? staleReason(effective, models) : undefined;
  const visibleHit = hit?.visible === true ? hit : undefined;
  const disabled = locked;
  return {
    id,
    ...SETTINGS_ROW_META[id],
    lead: false,
    route: effective,
    source,
    stale: visibleHit ? (effective && staleReason(effective, [visibleHit])) : stale,
    locked,
    profileLevel: false,
    directionSelf: false,
    agent: agentControl(id, agent, disabled),
    model: modelControl(id, effective, models, disabled),
    effort: effortControl(id, effective, visibleHit ?? hit, disabled),
  };
}

function leadRow(profile: Profile, models: readonly AgentModel[], profileLevelNote: boolean): SettingsRowView {
  const route = profile.lead;
  const hit = findModel(models, route.agent, route.model, route.provider_id);
  const visibleHit = hit?.visible === true ? hit : undefined;
  return {
    id: "lead",
    ...SETTINGS_ROW_META.lead,
    lead: true,
    route,
    source: profileLevelNote ? "作用于所有任务" : undefined,
    stale: staleReason(route, models),
    locked: false,
    profileLevel: true,
    directionSelf: false,
    agent: agentControl("lead", route.agent, false),
    model: modelControl("lead", route, models, false),
    effort: effortControl("lead", route, visibleHit ?? hit, false),
  };
}

function directionRow(manual: ModelManual, profile: Profile, taskType: TaskType, models: readonly AgentModel[], profileLevelNote: boolean): SettingsRowView {
  const self = !profile.direction_route && profile.direction_gate !== "astra";
  let route: Route | undefined;
  if (profile.direction_route) route = profile.direction_route;
  else if (profile.direction_gate === "astra") {
    try { route = resolveDirection(manual, profile.id, taskType).primary; } catch { route = undefined; }
  }
  const agent = (route?.agent ?? profile.lead.agent) as Harness;
  const classified = directionOptions(models, agent, profile.lead.model);
  const groups: SelectGroup[] = classified.groups.map((g) => ({
    label: `${g.label}（${g.options.length}）`,
    options: g.options.map((o) => ({ value: `${o.id}\t${o.providerId}`, label: `${o.name} · ${o.providerName}` })),
  }));
  const hit = route ? findModel(models, route.agent, route.model, route.provider_id) : undefined;
  const visibleHit = hit?.visible === true ? hit : undefined;
  let source = `只列比主控（${profile.lead.model}）强或持平的模型：强 ${classified.stronger} 个、持平 ${classified.equal} 个；较弱的 ${classified.hiddenWeaker} 个已隐藏。`;
  if (profileLevelNote) source = `作用于所有任务。${source}`;
  if (route && !self && !visibleHit) source = `${source} 当前配置不可选。`;
  return {
    id: "direction",
    ...SETTINGS_ROW_META.direction,
    lead: false,
    route,
    source,
    stale: route ? staleReason(route, models) : undefined,
    locked: false,
    profileLevel: true,
    directionSelf: self,
    hiddenWeaker: classified.hiddenWeaker,
    stronger: classified.stronger,
    equal: classified.equal,
    agent: agentControl("direction", agent, self),
    model: modelControl("direction", self ? undefined : route, models, false, {
      firstOption: { value: "", label: "主控自己定" },
      groups,
      placeholder: self ? "主控自己定" : undefined,
    }),
    effort: effortControl("direction", self ? undefined : route, visibleHit ?? hit, self),
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

export function buildSettingsView(
  manual: ModelManual,
  sel: { harness: SettingsHarness; profileId?: string; taskType: TaskType },
  catalog: readonly AgentModel[],
): SettingsView {
  const taskType: TaskType = sel.taskType;
  const taskScope: "all" | "task" = taskType === "default" ? "all" : "task";
  const picked = pickProfileForHarness(manual, sel.harness, sel.profileId);
  const tabs = [
    { id: "codex" as const, label: "Codex 主控", active: sel.harness === "codex" },
    { id: "claude-code" as const, label: "Claude Code 主控", active: sel.harness === "claude-code" },
  ];
  const base = {
    harness: sel.harness,
    tabs,
    taskType,
    taskScope,
    statusIds: SETTINGS_STATUS_IDS,
    accordionIds: SETTINGS_ACCORDION_IDS,
    rowIds: SETTINGS_ROW_IDS,
  };
  if (!picked.profile) {
    return { ...base, empty: picked.empty, overrideCount: 0, rows: [] };
  }
  const profile = picked.profile;
  const profileLevelNote = taskScope === "task";
  const rows: SettingsRowView[] = [
    leadRow(profile, catalog, profileLevelNote),
    directionRow(manual, profile, taskType, catalog, profileLevelNote),
    ...ROLES.map((role) => roleRow(role, manual, profile, taskType, catalog)),
  ];
  return {
    ...base,
    profileId: profile.id,
    profileName: profile.name,
    notice: picked.notice,
    overrideCount: overrideCount(profile),
    rows,
  };
}

export function routeAfterAgentChange(models: readonly AgentModel[], agent: Harness, prevEffort?: string): Route {
  const first = visibleModels(models, agent)[0];
  return first ? routeFromModel(first, prevEffort) : { agent, model: "", provider_id: "" };
}

export function routeAfterModelChange(models: readonly AgentModel[], agent: Harness, modelId: string, providerId: string, prevEffort?: string): Route {
  const hit = findModel(models, agent, modelId, providerId);
  return hit ? routeFromModel(hit, prevEffort) : { agent, model: modelId, provider_id: providerId };
}

export function routeAfterEffortChange(models: readonly AgentModel[], current: Route, effort: string): Route {
  const hit = findModel(models, current.agent, current.model, current.provider_id);
  if (hit) return routeFromModel(hit, effort || undefined);
  if (!effort) {
    const { effort: _drop, ...rest } = current;
    return rest;
  }
  return { ...current, effort };
}

export { materializeSlot };
