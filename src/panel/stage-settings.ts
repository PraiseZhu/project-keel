// Pure logic for the settings page "工作环节": view data, HTML fragments and edits. DOM and events stay in settings.ts.

import { DEFAULT_MANUAL, cloneManual, type AgentModel, type Harness, type ModelManual, type Profile, type Route } from "../shared/manual/schema.ts";
import {
  allowedHarnesses,
  blockedReason,
  clashesWithWriter,
  readStages,
  RESEARCH_PARALLEL,
  RESEARCH_SUB,
  setCodeRoutes,
  setPlanRoute,
  setReviewRoutes,
  stageModelAllowed,
  STAGE_HARNESSES,
  STAGE_HARNESS_LABELS,
  type StageHarness,
  type StageId,
} from "../shared/manual/stages.ts";
import { findModel, routeFromModel, staleReason, uniqueProfileId, type CatalogState } from "./manual-editor.ts";

// constants
export const STAGE_IDS: readonly StageId[] = ["plan", "code", "review"];
export const SLOT_IDS = ["primary", "fallback"] as const;
export type SlotId = (typeof SLOT_IDS)[number];
export const CATALOG_SELECT_ACTS = ["model", "effort"] as const;
export type CatalogSelectAct = (typeof CATALOG_SELECT_ACTS)[number];

export const STAGE_TITLES: Record<StageId, string> = { plan: "想方案", code: "写代码", review: "做检查" };
const AGENT_LABELS: Record<string, string> = { ...STAGE_HARNESS_LABELS, pi: "Pi" };

export function isStageId(v: unknown): v is StageId {
  return typeof v === "string" && (STAGE_IDS as readonly string[]).includes(v);
}
export function isSlotId(v: unknown): v is SlotId {
  return typeof v === "string" && (SLOT_IDS as readonly string[]).includes(v);
}
export function isSelectAct(v: unknown): v is CatalogSelectAct {
  return typeof v === "string" && (CATALOG_SELECT_ACTS as readonly string[]).includes(v);
}

// view types
export interface SelectOptionView {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}
export interface SelectGroupView {
  readonly label: string;
  readonly options: readonly SelectOptionView[];
}
export interface SelectView {
  readonly act: CatalogSelectAct;
  readonly stage: StageId;
  readonly slot: SlotId;
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly options: readonly SelectOptionView[];
  readonly groups: readonly SelectGroupView[];
}
export interface RouteControlsView {
  readonly model: SelectView;
  readonly effort: SelectView;
}
export interface StageRowView {
  readonly id: StageId;
  readonly title: string;
  readonly description: string;
  readonly primary: RouteControlsView;
  readonly fallback?: RouteControlsView;
  readonly notes: readonly string[];
}
export interface StageSettingsView {
  readonly harness: StageHarness;
  readonly profileId?: string;
  readonly missing: boolean;
  readonly catalogNote?: string;
  readonly research: { readonly title: string; readonly description: string; readonly label: string; readonly note: string };
  readonly rows: readonly StageRowView[];
  readonly problemCount: number;
}

// labels and model values
export function agentLabel(agent: string): string {
  return AGENT_LABELS[agent] ?? agent;
}
function gatewayOf(m: Pick<AgentModel, "providerId" | "providerName">): string {
  return m.providerName ?? m.providerId;
}
export function modelLabel(m: AgentModel): string {
  return `${m.name ?? m.id} · ${gatewayOf(m)}`;
}
export function routeName(route: Route, models: readonly AgentModel[]): string {
  const hit = findModel(models, route.agent, route.model, route.provider_id);
  return hit ? modelLabel(hit) : `${route.model} · ${route.provider_id}`;
}
export function modelValue(route?: Pick<Route, "agent" | "model" | "provider_id">): string {
  if (!route?.model || !route.provider_id) return "";
  return JSON.stringify([route.agent, route.model, route.provider_id]);
}
export function parseModelValue(value: string): { agent: string; id: string; providerId: string } | undefined {
  try {
    const p = JSON.parse(value) as unknown;
    if (Array.isArray(p) && p.length === 3 && p.every((x) => typeof x === "string")) return { agent: p[0] as string, id: p[1] as string, providerId: p[2] as string };
  } catch { /* not one of ours */ }
  return undefined;
}
export function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

// catalog arrival (late /agent-models responses must not destroy a select being operated)
export function isCatalogReady(state: Pick<CatalogState, "status" | "models">): boolean {
  return state.status === "ok" && state.models.some((m) => m.visible !== false);
}
export function acceptCatalogResponse(latestSeq: number, responseSeq: number): boolean {
  return latestSeq === responseSeq;
}
export function shouldRefreshCatalogOnOpen(opts: { act: string | null; programmatic: boolean }): boolean {
  if (opts.programmatic) return false;
  return isSelectAct(opts.act);
}
export type CatalogArrivalAction = "ignore" | "store" | "defer" | "store-and-render";
export function catalogArrivalAction(opts: { seqAccepted: boolean; interacting: boolean; render?: boolean }): CatalogArrivalAction {
  if (!opts.seqAccepted) return "ignore";
  if (opts.render === false) return "store";
  if (opts.interacting) return "defer";
  return "store-and-render";
}

// profile and candidates
export function profileForHarness(manual: ModelManual, harness: StageHarness): Profile | undefined {
  const id = manual.defaults_by_harness[harness];
  const profile = id ? manual.profiles.find((p) => p.id === id) : undefined;
  return profile && profile.harness === harness ? profile : undefined;
}

interface Ctx {
  readonly models: readonly AgentModel[];
  readonly lead: StageHarness;
  readonly writer?: Harness;
  readonly writerModel?: string;
}

/** Models a stage may pick: visible, runnable, on an allowed harness, deduped by agent × id × gateway. */
function candidates(stage: StageId, ctx: Ctx, onlyAgent?: string): AgentModel[] {
  const seen = new Set<string>();
  const out: AgentModel[] = [];
  for (const m of ctx.models) {
    if (!stageModelAllowed(stage, m, ctx.lead, ctx.writer, ctx.writerModel)) continue;
    if (onlyAgent !== undefined && m.agent !== onlyAgent) continue;
    const key = `${m.agent}\t${m.id}\t${m.providerId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

function optionOf(m: AgentModel): SelectOptionView {
  return { value: JSON.stringify([m.agent, m.id, m.providerId]), label: modelLabel(m) };
}

/** One optgroup per "执行框架 · 网关", Claude Code first, gateways in catalog order. */
function groupModels(list: readonly AgentModel[]): SelectGroupView[] {
  const groups: SelectGroupView[] = [];
  for (const agent of STAGE_HARNESSES) {
    const byGateway = new Map<string, AgentModel[]>();
    for (const m of list.filter((x) => x.agent === agent)) byGateway.set(m.providerId, [...(byGateway.get(m.providerId) ?? []), m]);
    for (const items of byGateway.values()) {
      groups.push({ label: `${agentLabel(agent)} · ${gatewayOf(items[0]!)}`, options: items.map(optionOf) });
    }
  }
  return groups;
}

// route edits
/** Keep the old effort when the new model supports it, else the model's default, else none. */
export function routeAfterModelChange(models: readonly AgentModel[], value: string, prevEffort?: string): Route | undefined {
  const key = parseModelValue(value);
  const hit = key ? findModel(models, key.agent, key.id, key.providerId) : undefined;
  if (!hit) return undefined;
  const efforts = hit.efforts ?? [];
  const want = prevEffort && efforts.includes(prevEffort) ? prevEffort : (hit.defaultEffort ?? undefined);
  return routeFromModel(hit, want);
}
export function routeAfterEffortChange(route: Route, value: string): Route {
  const { effort: _drop, ...rest } = route;
  return value ? { ...rest, effort: value } : rest;
}

// controls
interface ControlArgs {
  readonly stage: StageId;
  readonly slot: SlotId;
  readonly route?: Route;
  readonly optional: boolean;
  readonly list: readonly AgentModel[];
  readonly allowedAgents: readonly StageHarness[];
  readonly requireAgent?: string;
  readonly ctx: Ctx;
  readonly catalogReady: boolean;
  /** A backup row has nothing to attach to while its primary is missing. */
  readonly parentMissing?: boolean;
}

function whatOf(stage: StageId, slot: SlotId): string {
  return `${STAGE_TITLES[stage]}${slot === "fallback" ? "备用" : ""}`;
}

/** Why the saved route cannot run in this row. undefined = fine. */
function routeProblem(route: Route, a: ControlArgs): string | undefined {
  const blocked = blockedReason(route.agent, route.provider_id, route.model);
  if (blocked) return blocked;
  if (a.requireAgent !== undefined && route.agent !== a.requireAgent) return `备用要和主选用同一个执行框架（${agentLabel(a.requireAgent)}）。`;
  if (!(a.allowedAgents as readonly string[]).includes(route.agent)) return `这一行只能选 ${a.allowedAgents.map(agentLabel).join("、")} 的模型。`;
  return staleReason(route, a.ctx.models);
}

function effortSelect(a: ControlArgs, route: Route | undefined): SelectView {
  const base = { act: "effort" as const, stage: a.stage, slot: a.slot, label: `${whatOf(a.stage, a.slot)}推理强度`, groups: [] };
  const current = route?.effort ?? "";
  const hit = route ? findModel(a.ctx.models, route.agent, route.model, route.provider_id) : undefined;
  const live = hit && hit.visible !== false ? hit : undefined;
  if (!route || !live || !a.catalogReady || a.parentMissing) {
    return { ...base, value: current, disabled: true, options: [{ value: current, label: current || "默认" }] };
  }
  const efforts = live.efforts ?? [];
  const options: SelectOptionView[] = efforts.map((e) => ({ value: e, label: e }));
  const unsupported = current !== "" && !efforts.includes(current);
  if (current === "" || efforts.length === 0) options.unshift({ value: "", label: "默认" });
  if (unsupported) options.push({ value: current, label: `${current}（不支持）`, disabled: true });
  return { ...base, value: current, disabled: efforts.length === 0 && !unsupported, options };
}

function modelSelect(a: ControlArgs, route: Route | undefined): SelectView {
  const selected = modelValue(route);
  const groups = a.catalogReady ? groupModels(a.list) : [];
  const options: SelectOptionView[] = [];
  if (a.optional) options.push({ value: "", label: "不用备用" });
  else if (!route) options.push({ value: "", label: a.list.length ? "请选择模型" : "没有可选模型", disabled: true });
  const listed = groups.some((g) => g.options.some((o) => o.value === selected));
  if (route && selected && !listed) {
    if (a.catalogReady) options.push({ value: selected, label: `当前：${routeName(route, a.ctx.models)} · ${agentLabel(route.agent)}（不可用）`, disabled: true });
    else options.push({ value: selected, label: `${route.model} · ${route.provider_id}` });
  }
  const choices = groups.reduce((n, g) => n + g.options.length, 0) + (a.optional ? 1 : 0);
  return {
    act: "model",
    stage: a.stage,
    slot: a.slot,
    label: `${whatOf(a.stage, a.slot)}模型`,
    value: selected,
    disabled: !a.catalogReady || a.parentMissing === true || choices === 0,
    options,
    groups,
  };
}

function routeControls(a: ControlArgs): { controls: RouteControlsView; problem?: string } {
  const route = a.route?.model && a.route.provider_id ? a.route : undefined;
  const problem = a.catalogReady && route ? routeProblem(route, a) : undefined;
  const controls = { model: modelSelect(a, route), effort: effortSelect(a, route) };
  return problem ? { controls, problem } : { controls };
}

// view
const PLAN_DESCRIPTION = "主控先出一版，再开 1 个窗口用另一家模型独立出一版，主控挑一版用";

function reviewDescription(writer: Harness | undefined, allowed: readonly StageHarness[]): string {
  if (writer === undefined || allowed.length !== 1) return "做检查要和写代码用不同家的模型。";
  return `写代码用的是 ${agentLabel(writer)}，所以这里只能选 ${agentLabel(allowed[0]!)}`;
}

export function buildStageView(manual: ModelManual, harness: StageHarness, models: readonly AgentModel[], catalogReady: boolean): StageSettingsView {
  const sub = RESEARCH_SUB[harness];
  const research = { title: "查资料", description: `主控自带小助手，一次并行派 ${RESEARCH_PARALLEL} 个`, label: sub.label, note: sub.note };
  const catalogNote = catalogReady ? undefined : "模型清单暂时读不到，先显示已保存的配置；读到后才能修改。";
  const profile = profileForHarness(manual, harness);
  if (!profile) return { harness, missing: true, ...(catalogNote ? { catalogNote } : {}), research, rows: [], problemCount: 0 };

  const stages = readStages(manual, profile.id);
  const code = stages.code;
  const writer = code?.primary.agent;
  const ctx: Ctx = { models, lead: harness, ...(code ? { writer: code.primary.agent, writerModel: code.primary.model } : {}) };
  const planAllowed = allowedHarnesses("plan", harness);
  const reviewAllowed = allowedHarnesses("review", harness, writer);
  const rowOf = (id: StageId, description: string, primary: ReturnType<typeof routeControls>, fallback?: ReturnType<typeof routeControls>): StageRowView => {
    const notes = [primary.problem, fallback?.problem ? `备用路线：${fallback.problem}` : undefined].filter((n): n is string => !!n);
    return { id, title: STAGE_TITLES[id], description, primary: primary.controls, ...(fallback ? { fallback: fallback.controls } : {}), notes };
  };

  const plan = routeControls({ stage: "plan", slot: "primary", route: stages.plan, optional: false, list: candidates("plan", ctx), allowedAgents: planAllowed, ctx, catalogReady });
  const codeMain = routeControls({ stage: "code", slot: "primary", route: code?.primary, optional: false, list: candidates("code", ctx), allowedAgents: STAGE_HARNESSES, ctx, catalogReady });
  const codeBackup = routeControls({
    stage: "code", slot: "fallback", route: code?.fallbacks?.[0], optional: true,
    list: writer ? candidates("code", ctx, writer) : [], allowedAgents: STAGE_HARNESSES, ...(writer ? { requireAgent: writer } : {}), ctx, catalogReady, parentMissing: !code,
  });
  const reviewList = candidates("review", ctx);
  const reviewMain = routeControls({ stage: "review", slot: "primary", route: stages.review.primary, optional: false, list: reviewList, allowedAgents: reviewAllowed, ctx, catalogReady });
  const reviewBackup = routeControls({
    stage: "review", slot: "fallback", route: stages.review.fallbacks[0], optional: true, list: reviewList, allowedAgents: reviewAllowed, ctx, catalogReady, parentMissing: !stages.review.primary,
  });

  const rows = [
    rowOf("plan", PLAN_DESCRIPTION, plan),
    rowOf("code", "开 1 个窗口写", codeMain, codeBackup),
    rowOf("review", reviewDescription(writer, reviewAllowed), reviewMain, reviewBackup),
  ];
  return { harness, profileId: profile.id, missing: false, ...(catalogNote ? { catalogNote } : {}), research, rows, problemCount: rows.reduce((n, r) => n + r.notes.length, 0) };
}

// html
function renderOption(o: SelectOptionView, selected: string): string {
  return `<option value="${escapeHtml(o.value)}"${o.value === selected ? " selected" : ""}${o.disabled ? " disabled" : ""}>${escapeHtml(o.label)}</option>`;
}

export function renderSelectHtml(sel: SelectView): string {
  const flat = sel.options.map((o) => renderOption(o, sel.value)).join("");
  const groups = sel.groups.map((g) => `<optgroup label="${escapeHtml(g.label)}">${g.options.map((o) => renderOption(o, sel.value)).join("")}</optgroup>`).join("");
  return `<select class="${sel.act}" data-act="${sel.act}" data-stage="${sel.stage}" data-slot="${sel.slot}" aria-label="${escapeHtml(sel.label)}"${sel.disabled ? " disabled" : ""}>${flat}${groups}</select>`;
}

function renderPair(c: RouteControlsView): string {
  return `${renderSelectHtml(c.model)}${renderSelectHtml(c.effort)}`;
}

function renderRowHtml(row: StageRowView): string {
  const backup = row.fallback ? `<div class="pick fb"><span class="fb-label">用不了时换</span>${renderPair(row.fallback)}</div>` : "";
  const notes = row.notes.map((n) => `<p class="stage-warn">${escapeHtml(n)}</p>`).join("");
  return `<div class="row stage${row.notes.length ? " stale" : ""}" data-row="${row.id}"><div class="role"><b>${row.title}</b></div>`
    + `<div class="stage-main"><p class="stage-desc">${escapeHtml(row.description)}</p><div class="pick">${renderPair(row.primary)}</div>${backup}${notes}</div></div>`;
}

export function renderStageRowsHtml(view: StageSettingsView): string {
  if (view.missing) {
    return `<div class="empty">还没有这个主控的方案。<button type="button" class="btn" data-act="use-default">用默认值</button></div>`;
  }
  const r = view.research;
  const banner = view.catalogNote ? `<div class="stage-banner">${escapeHtml(view.catalogNote)}</div>` : "";
  const research = `<div class="row stage" data-row="research"><div class="role"><b>${r.title}</b></div>`
    + `<div class="stage-main"><p class="stage-desc">${escapeHtml(r.description)}</p>`
    + `<p class="stage-fixed"><b>${escapeHtml(r.label)}</b> <span class="muted">${escapeHtml(r.note)}</span></p></div></div>`;
  return banner + research + view.rows.map(renderRowHtml).join("");
}

// edits
export interface StageChange {
  readonly stage: StageId;
  readonly slot: SlotId;
  readonly act: CatalogSelectAct;
  readonly value: string;
}
export interface StageChangeResult {
  readonly manual: ModelManual;
  readonly notice?: string;
}

/** The catalog copy of a default route, re-fitted to the catalog's efforts. undefined = not runnable here. */
function fitDefault(route: Route | undefined, ctx: Ctx): Route | undefined {
  if (!route) return undefined;
  const hit = findModel(ctx.models, route.agent, route.model, route.provider_id);
  if (!hit || !stageModelAllowed("review", hit, ctx.lead, ctx.writer, ctx.writerModel)) return undefined;
  return routeAfterModelChange(ctx.models, modelValue(route), route.effort);
}

/** Default 做检查 pair for a writer: the shipped profile of that harness, else the first allowed model. */
function defaultReviewPair(models: readonly AgentModel[], lead: StageHarness, writer: Route): { primary: Route; fallback?: Route } | undefined {
  const ctx: Ctx = { models, lead, writer: writer.agent, writerModel: writer.model };
  const shipped = DEFAULT_MANUAL.profiles.find((p) => p.id === DEFAULT_MANUAL.defaults_by_harness[writer.agent]);
  let primary = fitDefault(shipped?.final_review_route, ctx);
  if (!primary) {
    const first = candidates("review", ctx)[0];
    primary = first ? routeAfterModelChange(models, optionOf(first).value, undefined) : undefined;
  }
  if (!primary) return undefined;
  const fallback = fitDefault(shipped?.final_review_fallbacks?.[0], ctx);
  return fallback && modelValue(fallback) !== modelValue(primary) ? { primary, fallback } : { primary };
}

type ReviewFix = { manual: ModelManual; kind?: "primary" | "fallback" | "none"; route?: Route };

/** After 写代码 changed, 做检查 must not stay on the writer's harness or model family. */
function reconcileReview(manual: ModelManual, profileId: string, lead: StageHarness, models: readonly AgentModel[], writer: Route): ReviewFix {
  const review = readStages(manual, profileId).review;
  if (!review.primary) return { manual };
  if (clashesWithWriter(review.primary.agent, review.primary.model, writer)) {
    const pair = defaultReviewPair(models, lead, writer);
    if (!pair) return { manual, kind: "none" };
    return { manual: setReviewRoutes(manual, profileId, pair.primary, pair.fallback), kind: "primary", route: pair.primary };
  }
  const backup = review.fallbacks[0];
  if (backup && clashesWithWriter(backup.agent, backup.model, writer)) return { manual: setReviewRoutes(manual, profileId, review.primary, undefined), kind: "fallback" };
  return { manual };
}

function currentRoute(manual: ModelManual, profileId: string, change: StageChange): Route | undefined {
  const s = readStages(manual, profileId);
  if (change.stage === "plan") return s.plan;
  if (change.stage === "code") return change.slot === "primary" ? s.code?.primary : s.code?.fallbacks?.[0];
  return change.slot === "primary" ? s.review.primary : s.review.fallbacks[0];
}

function writerChangeNotice(next: Route, models: readonly AgentModel[], droppedBackup: boolean, fix: ReviewFix): string | undefined {
  const parts: string[] = [];
  if (droppedBackup) parts.push("写代码的备用已清掉");
  if (fix.kind === "primary" && fix.route) parts.push(`做检查已自动改成 ${routeName(fix.route, models)}`);
  if (fix.kind === "fallback") parts.push("做检查的备用已清掉");
  if (fix.kind === "none") parts.push("做检查暂时没有可选的模型，请自己选一个");
  return parts.length ? `写代码换成了 ${routeName(next, models)}，${parts.join("，")}。` : undefined;
}

/** Apply one select change to the default profile of a harness. The model list decides what a new model's effort becomes. */
export function applyStageChange(manual: ModelManual, harness: StageHarness, models: readonly AgentModel[], change: StageChange): StageChangeResult {
  const profile = profileForHarness(manual, harness);
  if (!profile) return { manual };
  const id = profile.id;
  const current = currentRoute(manual, id, change);
  let next: Route | undefined;
  if (change.act === "model") {
    if (change.value === "") {
      if (change.slot === "primary") return { manual };
    } else {
      next = routeAfterModelChange(models, change.value, current?.effort);
      if (!next) return { manual };
    }
  } else {
    if (!current) return { manual };
    next = routeAfterEffortChange(current, change.value);
  }
  const stages = readStages(manual, id);
  if (change.stage === "plan") return next ? { manual: setPlanRoute(manual, id, next) } : { manual };
  if (change.stage === "review") {
    if (change.slot === "primary") return next ? { manual: setReviewRoutes(manual, id, next, stages.review.fallbacks[0]) } : { manual };
    if (!stages.review.primary) return { manual };
    return { manual: setReviewRoutes(manual, id, stages.review.primary, next) };
  }
  const code = stages.code;
  if (change.slot === "fallback") return code ? { manual: setCodeRoutes(manual, id, code.primary, next) } : { manual };
  if (!next) return { manual };
  const backup = code?.fallbacks?.[0];
  const keep = backup && backup.agent === next.agent ? backup : undefined;
  const written = setCodeRoutes(manual, id, next, keep);
  if (!code) return { manual: written };
  const fix = reconcileReview(written, id, harness, models, next);
  const notice = writerChangeNotice(next, models, backup !== undefined && keep === undefined, fix);
  return { manual: fix.manual, ...(notice ? { notice } : {}) };
}

/** 「用默认值」: add the shipped profile of this harness to the draft and make it the default. */
export function addDefaultProfile(manual: ModelManual, harness: StageHarness): ModelManual {
  const shippedId = DEFAULT_MANUAL.defaults_by_harness[harness];
  const shipped = cloneManual(DEFAULT_MANUAL).profiles.find((p) => p.id === shippedId);
  if (!shipped) return manual;
  const id = uniqueProfileId(manual.profiles.map((p) => p.id), shipped.id);
  return { ...manual, profiles: [...manual.profiles, { ...shipped, id }], defaults_by_harness: { ...manual.defaults_by_harness, [harness]: id } };
}
