// Settings page: the key is handed straight to the host vault (/secrets); never to /kv or logs.
import {
  addProfile,
  canDeleteProfile,
  copyProfile,
  deleteProfile,
  fetchCatalog,
  fingerprintManual,
  HARNESS_LABELS,
  loadManualFromKv,
  materializeSlot,
  parseImportedJson,
  prettyExport,
  profileList,
  renameProfile,
  saveManual,
  setHarnessDefault,
  setInherit,
  setLead,
  setProfileHarness,
  setSlot,
  TASK_LABELS,
  withSavedVersion,
  type CatalogState,
  type SettingsIO,
} from "./manual-editor.ts";
import {
  addGroupCollaborator,
  addRoleCollaborator,
  applyGroupClear,
  applyGroupCollaborators,
  applyGroupPrimary,
  applyRoleCollaborators,
  applyRolePrimary,
  isGroupId,
  removeGroupCollaborator,
  removeRoleCollaborator,
  replaceCollaborator,
  type FineTuneId,
  type GroupId,
} from "./grouped-models.ts";
import {
  acceptCatalogResponse,
  buildSettingsView,
  catalogArrivalAction,
  CATALOG_SELECT_ACTS,
  editableSlot,
  escapeHtml as esc,
  filterKey,
  renderGroupsHtml,
  renderInheritOptionHtml,
  renderLeadHtml,
  renderProfileButtonHtml,
  routeAfterEffortChange,
  routeAfterUnifiedChange,
  SESSION_NOTE,
  SETTINGS_ROW_IDS,
  shouldRefreshCatalogOnOpen,
  TASK_SCOPE_TYPES,
  type SettingsHarness,
  type SettingsRowId,
  type SettingsTarget,
  type SettingsUiState,
} from "./settings-model.ts";
import { cloneManual, DEFAULT_MANUAL, HARNESSES, MAX_FALLBACKS, ROLES, type Harness, type ModelManual, type Role, type Route, type Slot, type TaskType } from "../shared/manual/schema.ts";
import { clockTone, renderClockStatus, stopHookTone, type StopHookInstall } from "./hooks-status.ts";
import { readReplyMode, REPLY_MODE_LABELS, saveReplyMode, type ReplyMode } from "./reply-setting.ts";
import { parseKvResponse } from "../shared/kv-response.ts";

const io: SettingsIO = {
  async getKv() {
    const r = await fetch("/kv");
    if (!r.ok) return parseKvResponse(r.status, false, null);
    return parseKvResponse(r.status, true, await r.json());
  },
  async putKv(kv) {
    try {
      const r = await fetch("/kv", { method: "PUT", body: JSON.stringify(kv) });
      if (r.status === 204) return { ok: true, status: 204 };
      return { ok: false, status: r.status, message: `写入 /kv 失败（HTTP ${r.status}）。` };
    } catch (e) {
      return { ok: false, status: 0, message: e instanceof Error ? e.message : "写入 /kv 失败。" };
    }
  },
  async getAgentModels() {
    const r = await fetch("/agent-models");
    let body: unknown;
    try { body = await r.json(); } catch { body = undefined; }
    return { status: r.status, body };
  },
  broadcast(message) {
    if (typeof BroadcastChannel !== "undefined") new BroadcastChannel("keel").postMessage(message);
  },
};

let draft: ModelManual = cloneManual(DEFAULT_MANUAL);
let baseline: ModelManual = cloneManual(DEFAULT_MANUAL);
let loadedFingerprint = "";
let loadInvalid = false;
let harness: SettingsHarness = "codex";
let selectedId: string | undefined = draft.defaults_by_harness.codex;
let taskType: TaskType = "default";
let catalog: CatalogState = { status: "error", models: [], retry: false, message: "" };
let catalogSeq = 0;
let catalogInflight: Promise<CatalogState> | undefined;
let catalogInteracting = false;
let catalogProgrammaticFocus = false;
let pendingCatalog: CatalogState | undefined;
const expandedFallbackRows = new Set<string>();
const fineTuneOpen = new Set<string>();
const filterOpen = new Set<string>();
const filterQuery = new Map<string, string>();

const input = document.querySelector<HTMLInputElement>("#key");
const statusEl = document.querySelector<HTMLElement>("#status");
const jevSummary = document.querySelector<HTMLElement>("#jev-summary");

type StatusId = "jev" | "catalog" | "hooks" | "clock";
type Tone = "ok" | "warn" | "unknown";

/** Status strip: the dot carries the state; text appears only for a problem; the full line goes in the tooltip. */
function setStatus(id: StatusId, tone: Tone, problem: string, detail: string): void {
  const dot = document.querySelector<HTMLElement>(`#status-${id}-dot`);
  if (dot) dot.className = `dot ${tone}`;
  const value = document.querySelector<HTMLElement>(`#status-${id}-value`);
  if (value) value.textContent = problem;
  document.querySelector<HTMLElement>(`[data-status="${id}"]`)?.setAttribute("title", detail);
}

/** announce=true after a save/clear so the accordion confirms the action; page load only paints the state. */
async function refreshJev(announce = false): Promise<void> {
  const r = await fetch("/secrets");
  if (!r.ok) throw new Error("status");
  const entries = (await r.json()) as { key: string; saved: boolean; tail?: string }[];
  const key = entries.find((x) => x.key === "api_key");
  const text = key?.saved ? `已保存${key.tail ? ` · 尾号 ${key.tail}` : ""}` : "未配置";
  if (jevSummary) jevSummary.textContent = `${text} ›`;
  if (announce && statusEl) statusEl.textContent = key?.saved ? "已保存" : "已清除";
  setStatus("jev", key?.saved ? "ok" : "warn", key?.saved ? "" : "未配置", `Jev 凭证：${text}`);
}

document.querySelector("#form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!input || !statusEl) return;
  const value = input.value.trim();
  input.value = "";
  if (!value) {
    statusEl.textContent = "请输入 API Key。";
    return;
  }
  try {
    const r = await fetch("/secrets/api_key", { method: "PUT", body: JSON.stringify({ value }) });
    if (r.status !== 204) throw new Error("save");
    await refreshJev(true);
  } catch {
    statusEl.textContent = "保存失败，请重新输入并重试。";
  }
});

document.querySelector("#clear")?.addEventListener("click", async () => {
  if (input) input.value = "";
  try {
    const r = await fetch("/secrets/api_key", { method: "DELETE" });
    if (!r.ok) throw new Error("clear");
    await refreshJev(true);
  } catch {
    if (statusEl) statusEl.textContent = "清除失败，请重试。";
  }
});

declare const __KEEL_PROFILE__: { lanes?: { repo: string; preset: string; preflight?: string; verifyCheck?: string }[]; routingPath?: string | null; plansDir?: string | null; boardRepos?: string[] };
const prof = typeof __KEEL_PROFILE__ === "undefined" ? {} : __KEEL_PROFILE__;
const lanesEl = document.querySelector<HTMLElement>("#lanes");
const lanesSummary = document.querySelector<HTMLElement>("#lanes-summary");
if (lanesEl) {
  const n = (prof.lanes ?? []).length;
  if (lanesSummary) lanesSummary.textContent = `${n} 个仓 ›`;
  const rows = (prof.lanes ?? []).map((l) => `<tr><td><code>${esc(l.repo)}</code></td><td>${esc(l.preset)}</td><td>${l.preflight ? "有" : "—"}</td><td>${l.verifyCheck ? `<code>${esc(l.verifyCheck)}</code>` : "—"}</td></tr>`).join("") || '<tr><td colspan="4">未配置，所有仓按 personal 车道处理</td></tr>';
  lanesEl.innerHTML = `<table><thead><tr><th>仓库</th><th>车道</th><th>推送前预检</th><th>验证状态</th></tr></thead><tbody>${rows}</tbody></table>`;
}

refreshJev().catch(() => {
  if (jevSummary) jevSummary.textContent = "无法读取 ›";
  setStatus("jev", "unknown", "无法读取", "Jev 凭证：无法读取，请重新打开插件详情");
});

let hooksSeen = false;
if (typeof BroadcastChannel !== "undefined") {
  const ch = new BroadcastChannel("keel");
  ch.addEventListener("message", (ev) => {
    const m = ev.data as { type?: string; message?: string; result?: { claude_code?: string; codex?: string; state?: string; error?: string; failCount?: number } };
    if (m?.type === "clock-status") {
      const tone = clockTone(m.result);
      const text = renderClockStatus(m.result);
      setStatus("clock", tone, tone === "ok" ? "" : text.replace(/^常驻时钟：/, ""), text.replace(/^常驻时钟/, "后台时钟"));
      return;
    }
    if (m?.type !== "hooks-status") return;
    hooksSeen = true;
    const claude = m.result?.claude_code;
    const codex = m.result?.codex;
    const ok = (s: unknown): s is StopHookInstall => s === "installed" || s === "not_installed" || s === "unreadable";
    if (m.message || !ok(claude) || !ok(codex)) {
      setStatus("hooks", "unknown", "无法读取", "收工拦截：无法读取");
      return;
    }
    const hookLabel = (s: StopHookInstall) => s === "installed" ? "已装" : s === "not_installed" ? "未装" : "无法读取";
    const tones = [stopHookTone(codex), stopHookTone(claude)];
    const tone: Tone = tones.includes("warn") ? "warn" : tones.includes("unknown") ? "unknown" : "ok";
    const problems = [codex !== "installed" ? `Codex ${hookLabel(codex)}` : "", claude !== "installed" ? `Claude Code ${hookLabel(claude)}` : ""].filter(Boolean).join("、");
    setStatus("hooks", tone, problems, `收工拦截：Codex ${hookLabel(codex)}，Claude Code ${hookLabel(claude)}`);
  });
  void (async () => {
    try { await fetch("cindy-ghost://keel/wake"); } catch { /* already awake */ }
    const reqId = `hooks-${Date.now()}`;
    for (let i = 0; i < 10; i++) {
      ch.postMessage({ reqId, op: "hooks-status" });
      ch.postMessage({ reqId: `clock-${reqId}`, op: "clock-status" });
      await new Promise((r) => setTimeout(r, 400));
      if (hooksSeen) break;
    }
  })();
}

const manualStatus = document.querySelector<HTMLElement>("#manual-status");
const manualFile = document.querySelector<HTMLInputElement>("#manual-file");
const rowsEl = document.querySelector<HTMLElement>("#model-rows");
const taskbar = document.querySelector<HTMLElement>("#taskbar");
const hintEl = document.querySelector<HTMLElement>("#model-hint");
const saveBtn = document.querySelector<HTMLButtonElement>("[data-act=\"save\"]");
const advancedBody = document.querySelector<HTMLElement>("#advanced-body");
const scopeBanner = document.querySelector<HTMLElement>("#scope-banner");
const scopeSummary = document.querySelector<HTMLElement>("#scope-summary");
const leadRow = document.querySelector<HTMLElement>("#lead-row");
const UNSAVED = "有改动未保存";
/** The draft as last loaded or saved; Save is enabled only when the draft differs from it. */
let savedJson = JSON.stringify(draft);

function setManualStatus(kind: "ok" | "error" | "info", text: string, issues?: { path: string; message: string }[]): void {
  if (!manualStatus) return;
  const extra = (issues ?? []).map((i) => `${i.path ? i.path + "：" : ""}${i.message}`).join("\n");
  manualStatus.className = kind === "ok" ? "ok" : kind === "error" ? "issues" : "hint";
  manualStatus.textContent = extra ? `${text}\n${extra}` : text;
}

function paintDirty(): void {
  const dirty = JSON.stringify(draft) !== savedJson;
  if (saveBtn) saveBtn.disabled = !dirty || loadInvalid;
  if (!manualStatus || manualStatus.className === "issues") return;
  if (loadInvalid) return;
  if (dirty) setManualStatus("info", UNSAVED);
  else if (manualStatus.textContent === UNSAVED) setManualStatus("info", "");
}

function uiState(): SettingsUiState {
  return { fineTuneOpen, fallbackOpen: expandedFallbackRows, filterOpen, filterQuery };
}

function currentView() {
  return buildSettingsView(draft, { harness, profileId: selectedId, taskType }, catalog.models, uiState());
}

function renderAdvanced(view: ReturnType<typeof currentView>): void {
  if (!advancedBody) return;
  const items = profileList(draft, view.profileId);
  const selected = draft.profiles.find((p) => p.id === view.profileId);
  const inheritOpts = draft.profiles.filter((p) => p.id !== view.profileId).map((p) => renderInheritOptionHtml(p, selected?.inherit)).join("");
  const profileBtns = items.map((p) => renderProfileButtonHtml(p)).join("");
  advancedBody.innerHTML = `<div class="adv-row">${profileBtns}<span class="sep"></span>
      <button type="button" data-act="add">新增</button>
      <button type="button" data-act="copy">复制</button>
      <button type="button" data-act="delete">删除</button></div>
    ${selected ? `<div class="adv-row">名称 <input type="text" data-act="rename" value="${esc(selected.name)}">
      主控环境 <select data-act="adv-harness">${HARNESSES.map((h) => `<option value="${h}"${selected.harness === h ? " selected" : ""}>${HARNESS_LABELS[h]}</option>`).join("")}</select>
      沿用方案 <select data-act="inherit"><option value="">不沿用</option>${inheritOpts}</select>
      <label><input type="checkbox" data-act="default"${draft.defaults_by_harness[selected.harness] === selected.id ? " checked" : ""}> 设为${HARNESS_LABELS[selected.harness]}默认</label></div>` : ""}
    <div class="adv-row">
      <button type="button" data-act="export">导出 JSON</button>
      <button type="button" data-act="import">导入 JSON</button>
      <span class="sep"></span>
      <button type="button" data-act="restore">恢复默认</button></div>`;
}

function renderManual(restore?: { act: string; row: string; i?: number }): void {
  const view = currentView();
  selectedId = view.profileId ?? selectedId;
  document.querySelectorAll<HTMLButtonElement>("#model-tabs [data-harness]").forEach((b) => {
    const on = b.dataset.harness === harness;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll<HTMLButtonElement>("#task-scope [data-scope]").forEach((b) => {
    b.classList.toggle("on", (taskType === "default" ? "all" : "task") === b.dataset.scope);
  });
  if (taskbar) {
    taskbar.hidden = view.taskScope !== "task";
    if (view.taskScope === "task") {
      taskbar.innerHTML = `<div class="tabs">${TASK_SCOPE_TYPES.map((t) => `<button type="button" data-act="task" data-task="${t}"${t === taskType ? " class=\"on\"" : ""}>${TASK_LABELS[t]}</button>`).join("")}</div>`;
    }
  }
  if (scopeBanner) scopeBanner.textContent = `当前说明书：${view.scopeLabel} · ${SESSION_NOTE}`;
  if (scopeSummary) scopeSummary.textContent = `${view.scopeLabel} ›`;
  if (hintEl) {
    hintEl.textContent = view.taskScope === "task"
      ? `只改和默认设置不同的角色 · 已单独设置 ${view.overrideCount} 处。默认列改动不会删掉这些覆盖。`
      : (view.overrideCount
        ? `分组写入默认列，保留 ${view.overrideCount} 处任务专属覆盖；bug-fix 等仍用各自覆盖，不会因为改四组而静默删掉。`
        : (view.notice ?? ""));
  }
  if (catalog.status === "ok") {
    const n = catalog.models.filter((m) => m.visible !== false).length;
    setStatus("catalog", n ? "ok" : "warn", n ? "" : "为空", `模型清单：已启用 ${n} 项`);
  } else {
    const problem = catalog.status === "upgrade" ? "需升级 Cindy" : catalog.status === "retry" ? "暂时不可用" : "读取失败";
    setStatus("catalog", "warn", problem, catalog.message || `模型清单：${problem}`);
  }
  if (rowsEl) {
    if (view.empty) rowsEl.innerHTML = `<div class="empty">${esc(view.empty)}</div>`;
    else rowsEl.innerHTML = renderGroupsHtml(view.groups, taskType);
  }
  if (leadRow) leadRow.innerHTML = view.lead ? renderLeadHtml(view.lead) : "";
  renderAdvanced(view);
  paintDirty();
  if (restore && (rowsEl || leadRow)) {
    catalogProgrammaticFocus = true;
    try {
      const iSel = restore.i === undefined ? "" : `[data-i="${restore.i}"]`;
      const root = document;
      const el = root.querySelector<HTMLElement>(`[data-act="${restore.act}"][data-row="${restore.row}"]${iSel}`);
      if (el && typeof el.focus === "function" && !(el as HTMLSelectElement).disabled) el.focus();
    } finally {
      catalogProgrammaticFocus = false;
    }
  }
}

function focusedModelControl(): { act: string; row: string; i?: number } | undefined {
  const el = document.activeElement;
  if (!el || (!(rowsEl?.contains(el) || leadRow?.contains(el)))) return undefined;
  if (el.tagName !== "SELECT") return undefined;
  const act = el.getAttribute("data-act");
  const row = el.getAttribute("data-row");
  if (!act || !(CATALOG_SELECT_ACTS as readonly string[]).includes(act)) return undefined;
  if (!row || !(SETTINGS_ROW_IDS as readonly string[]).includes(row)) return undefined;
  const iRaw = el.getAttribute("data-i");
  const i = iRaw === null ? undefined : Number(iRaw);
  return i === undefined || Number.isNaN(i) ? { act, row } : { act, row, i };
}

function currentSlot(role: Role): Slot {
  return editableSlot(draft, selectedId ?? "", taskType, role);
}

function asTarget(value: string | null | undefined): SettingsTarget {
  if (value === "group" || value === "lead" || value === "role") return value;
  return "role";
}

async function doSave(next = draft): Promise<void> {
  if (loadInvalid && next !== draft && JSON.stringify(next) !== JSON.stringify(DEFAULT_MANUAL) && JSON.stringify(next) !== JSON.stringify(withSavedVersion(DEFAULT_MANUAL))) {
    setManualStatus("error", "说明书无法读取，未覆盖已有内容。请先恢复默认或修好 JSON 再保存。");
    return;
  }
  setManualStatus("info", "正在保存…");
  await refreshCatalog({ render: false });
  let result: Awaited<ReturnType<typeof saveManual>>;
  try {
    result = await saveManual(io, next, catalog.models, { expectedFingerprint: loadedFingerprint, baseline });
  } catch (e) {
    setManualStatus("error", `未写入：${e instanceof Error ? e.message : "读取 /kv 失败。"}`);
    return;
  }
  if (result.ok) {
    draft = withSavedVersion(next);
    baseline = cloneManual(draft);
    savedJson = JSON.stringify(draft);
    loadedFingerprint = fingerprintManual(draft);
    loadInvalid = false;
    const view = currentView();
    selectedId = view.profileId ?? draft.profiles[0]?.id;
    setManualStatus("ok", "已保存");
    renderManual();
    return;
  }
  if (result.kind === "invalid") setManualStatus("error", "校验未通过，未写入。", result.issues);
  else setManualStatus("error", result.message);
}

function takePendingCatalog(): boolean {
  if (!pendingCatalog) return false;
  catalog = pendingCatalog;
  pendingCatalog = undefined;
  return true;
}

function endSelectInteraction(): void {
  if (!catalogInteracting) return;
  catalogInteracting = false;
  if (takePendingCatalog()) renderManual();
}

async function refreshCatalog(opts?: { render?: boolean }): Promise<void> {
  const seq = ++catalogSeq;
  if (!catalogInflight) catalogInflight = fetchCatalog(io).finally(() => { catalogInflight = undefined; });
  const next = await catalogInflight;
  const action = catalogArrivalAction({
    seqAccepted: acceptCatalogResponse(catalogSeq, seq),
    interacting: catalogInteracting,
    render: opts?.render,
  });
  if (action === "ignore") return;
  if (action === "defer") {
    pendingCatalog = next;
    return;
  }
  catalog = next;
  pendingCatalog = undefined;
  if (action === "store-and-render") renderManual(focusedModelControl());
}

function onCatalogOpen(ev: Event): void {
  const t = ev.target as HTMLElement;
  if (!shouldRefreshCatalogOnOpen({ act: t.getAttribute("data-act"), programmatic: catalogProgrammaticFocus })) return;
  catalogInteracting = true;
  void refreshCatalog();
}

rowsEl?.addEventListener("focusin", onCatalogOpen);
rowsEl?.addEventListener("mousedown", onCatalogOpen);
rowsEl?.addEventListener("pointerdown", onCatalogOpen);
leadRow?.addEventListener("focusin", onCatalogOpen);
leadRow?.addEventListener("mousedown", onCatalogOpen);
leadRow?.addEventListener("pointerdown", onCatalogOpen);

function endIfLeft(root: HTMLElement | null, ev: FocusEvent): void {
  if (!root) return;
  const related = ev.relatedTarget as Node | null;
  if (related && root.contains(related)) return;
  endSelectInteraction();
}
rowsEl?.addEventListener("focusout", (ev) => endIfLeft(rowsEl, ev as FocusEvent));
leadRow?.addEventListener("focusout", (ev) => endIfLeft(leadRow, ev as FocusEvent));

rowsEl?.addEventListener("toggle", (ev) => {
  const details = ev.target as HTMLDetailsElement;
  const group = details.dataset.group;
  if (!group) return;
  if (details.open) fineTuneOpen.add(group);
  else fineTuneOpen.delete(group);
}, true);

document.querySelector("#model-tabs")?.addEventListener("click", (ev) => {
  const t = (ev.target as HTMLElement).closest<HTMLElement>("[data-harness]");
  if (!t?.dataset.harness) return;
  harness = t.dataset.harness as SettingsHarness;
  selectedId = draft.defaults_by_harness[harness] ?? draft.profiles.find((p) => p.harness === harness)?.id;
  renderManual();
});

document.querySelector("#task-scope")?.addEventListener("click", (ev) => {
  const t = (ev.target as HTMLElement).closest<HTMLElement>("[data-scope]");
  if (!t?.dataset.scope) return;
  taskType = t.dataset.scope === "task" ? (taskType === "default" ? "bug-fix" : taskType) : "default";
  renderManual();
});

taskbar?.addEventListener("click", (ev) => {
  const t = (ev.target as HTMLElement).closest<HTMLElement>("[data-task]");
  if (!t?.dataset.task) return;
  taskType = t.dataset.task as TaskType;
  renderManual();
});

function onActClick(ev: Event): void {
  const t = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]");
  if (!t) return;
  const act = t.dataset.act;
  if (act === "save") void doSave();
  else if (act === "restore") void doSave(cloneManual(DEFAULT_MANUAL));
  else if (act === "export") {
    const blob = new Blob([prettyExport(draft)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "keel-manual.json";
    a.click();
    setManualStatus("info", "已导出当前说明书 JSON。");
  } else if (act === "import") manualFile?.click();
  else if (act === "retry-catalog") void refreshCatalog();
  else if (act === "select") {
    selectedId = t.dataset.id ?? selectedId;
    const p = draft.profiles.find((x) => x.id === selectedId);
    if (p && (p.harness === "codex" || p.harness === "claude-code")) harness = p.harness;
    renderManual();
  } else if (act === "add") {
    const r = addProfile(draft);
    draft = r.manual;
    selectedId = r.id;
    renderManual();
  } else if (act === "copy") {
    if (!selectedId) return;
    const r = copyProfile(draft, selectedId);
    draft = r.manual;
    selectedId = r.id;
    renderManual();
  } else if (act === "delete") {
    if (!selectedId) return;
    const gate = canDeleteProfile(draft, selectedId);
    if (!gate.ok) return setManualStatus("error", gate.reason);
    const r = deleteProfile(draft, selectedId);
    if ("error" in r) return setManualStatus("error", r.error);
    draft = r.manual;
    selectedId = draft.defaults_by_harness[harness] ?? draft.profiles[0]?.id;
    renderManual();
  } else if (act === "own" && selectedId) {
    const role = t.dataset.row as Role;
    draft = setSlot(draft, selectedId, taskType, role, materializeSlot(draft, selectedId, taskType, role));
    renderManual();
  } else if (act === "inherit-slot" && selectedId) {
    const role = t.dataset.row as Role;
    draft = setSlot(draft, selectedId, taskType, role, undefined);
    renderManual();
  } else if (act === "toggle-fb") {
    const row = t.dataset.row;
    if (!row || !(ROLES as readonly string[]).includes(row)) return;
    const open = !expandedFallbackRows.has(row);
    if (open) expandedFallbackRows.add(row);
    else expandedFallbackRows.delete(row);
    t.closest(".role-editor")?.classList.toggle("open", open);
    t.setAttribute("aria-expanded", String(open));
  } else if (act === "add-fb" && selectedId) {
    const row = t.dataset.row;
    if (!row || !(ROLES as readonly string[]).includes(row)) return;
    const role = row as Role;
    const slot = currentSlot(role);
    if ((slot.fallbacks ?? []).length >= MAX_FALLBACKS) return;
    const blank: Route = { agent: slot.primary.agent, model: "", provider_id: "" };
    const next = [...(slot.fallbacks ?? []), blank];
    draft = setSlot(draft, selectedId, taskType, role, { ...slot, fallbacks: next });
    expandedFallbackRows.add(role);
    renderManual({ act: "fb-model", row, i: next.length - 1 });
  } else if (act === "del-fb" && selectedId) {
    const row = t.dataset.row;
    if (!row || !(ROLES as readonly string[]).includes(row)) return;
    const role = row as Role;
    const i = Number(t.dataset.i);
    const slot = currentSlot(role);
    const fallbacks = (slot.fallbacks ?? []).filter((_, idx) => idx !== i);
    draft = setSlot(draft, selectedId, taskType, role, { primary: slot.primary, ...(fallbacks.length ? { fallbacks } : {}), ...(slot.collaborators?.length ? { collaborators: slot.collaborators } : {}) });
    renderManual({ act: "add-fb", row });
  } else if (act === "filter") {
    const row = t.dataset.row ?? "";
    const kind = t.dataset.kind ?? "primary";
    const i = Number(t.dataset.i ?? "0");
    const key = filterKey(row, kind, i);
    if (filterOpen.has(key)) {
      filterOpen.delete(key);
      filterQuery.delete(key);
    } else filterOpen.add(key);
    renderManual({ act: "search", row, i });
    const search = document.querySelector<HTMLInputElement>(`[data-act="search"][data-row="${row}"][data-i="${i}"]`);
    if (search && !search.hidden) search.focus();
  } else if (act === "add-collab" && selectedId) {
    const row = t.dataset.row ?? "";
    const target = asTarget(t.dataset.target);
    if (target === "group" && isGroupId(row)) {
      draft = addGroupCollaborator(draft, selectedId, taskType, row);
      const n = currentView().groups.find((g) => g.id === row)?.collaborators.length ?? 1;
      renderManual({ act: "collab-model", row, i: Math.max(0, n - 1) });
      return;
    }
    draft = addRoleCollaborator(draft, selectedId, taskType, row as FineTuneId);
    renderManual({ act: "collab-model", row });
  } else if (act === "del-collab" && selectedId) {
    const row = t.dataset.row ?? "";
    const i = Number(t.dataset.i);
    const target = asTarget(t.dataset.target);
    if (target === "group" && isGroupId(row)) draft = removeGroupCollaborator(draft, selectedId, taskType, row, i);
    else draft = removeRoleCollaborator(draft, selectedId, taskType, row as FineTuneId, i);
    renderManual();
  }
}

document.querySelector(".bar")?.addEventListener("click", onActClick);
advancedBody?.addEventListener("click", onActClick);
rowsEl?.addEventListener("click", onActClick);
leadRow?.addEventListener("click", onActClick);

function applyUnified(row: string, target: SettingsTarget, kind: "primary" | "collaborator", index: number, next: Route, clear: boolean): void {
  if (!selectedId) return;
  if (target === "lead") {
    draft = setLead(draft, selectedId, next);
    return;
  }
  if (target === "group" && isGroupId(row)) {
    if (kind === "primary") {
      if (clear && row === "review") draft = applyGroupClear(draft, selectedId, row);
      else if (!clear) draft = applyGroupPrimary(draft, selectedId, taskType, row as GroupId, next);
      return;
    }
    const group = currentView().groups.find((g) => g.id === row);
    const blank: Route = { agent: next.agent, model: "", provider_id: "" };
    const list = replaceCollaborator(group?.collaborators.map((c) => c.route ?? blank) ?? [], index, next);
    draft = applyGroupCollaborators(draft, selectedId, taskType, row as GroupId, list);
    return;
  }
  const role = row as FineTuneId;
  if (kind === "primary") {
    draft = applyRolePrimary(draft, selectedId, taskType, role, clear ? undefined : next);
    return;
  }
  const view = currentView();
  const fine = view.groups.flatMap((g) => g.fineTune).find((r) => r.id === role);
  const blank: Route = { agent: next.agent, model: "", provider_id: "" };
  const list = replaceCollaborator(fine?.collaborators.map((c) => c.route ?? blank) ?? [], index, next);
  draft = applyRoleCollaborators(draft, selectedId, taskType, role, list);
}

function onControlChange(ev: Event): void {
  const t = ev.target as HTMLInputElement | HTMLSelectElement;
  const act = t.dataset.act;
  const row = t.dataset.row ?? "";
  const target = asTarget(t.dataset.target);
  const index = Number(t.dataset.i ?? "0");
  if (act === "rename" && selectedId) draft = renameProfile(draft, selectedId, t.value);
  else if (act === "adv-harness" && selectedId) {
    draft = setProfileHarness(draft, selectedId, t.value as Harness);
    renderManual();
  } else if (act === "inherit" && selectedId) {
    draft = setInherit(draft, selectedId, t.value || undefined);
    renderManual();
  } else if (act === "default" && selectedId) {
    draft = setHarnessDefault(draft, selectedId, (t as HTMLInputElement).checked);
    renderManual();
  } else if (act === "search") {
    const kind = t.dataset.kind ?? "primary";
    filterQuery.set(filterKey(row, kind, index), t.value);
    renderManual({ act: "search", row, i: index });
  } else if ((act === "model" || act === "effort" || act === "collab-model" || act === "collab-effort") && row) {
    catalogInteracting = false;
    takePendingCatalog();
    const kind: "primary" | "collaborator" = act.startsWith("collab") ? "collaborator" : "primary";
    const view = currentView();
    let prev: Route | undefined;
    if (target === "lead") prev = view.lead?.route;
    else if (target === "group" && isGroupId(row)) {
      const g = view.groups.find((x) => x.id === row);
      prev = kind === "primary" ? g?.primary?.route : g?.collaborators[index]?.route;
    } else {
      const fine = view.groups.flatMap((g) => g.fineTune).find((r) => r.id === row);
      prev = kind === "primary" ? fine?.route : fine?.collaborators[index]?.route;
    }
    if (act === "model" || act === "collab-model") {
      if (!t.value) {
        applyUnified(row, target, kind, index, { agent: prev?.agent ?? "codex", model: "", provider_id: "" }, true);
        renderManual({ act, row, i: index });
        return;
      }
      const next = routeAfterUnifiedChange(catalog.models, t.value, prev?.effort);
      applyUnified(row, target, kind, index, next, false);
      renderManual({ act, row, i: index });
      return;
    }
    if (!prev?.model) return;
    applyUnified(row, target, kind, index, routeAfterEffortChange(catalog.models, prev, t.value), false);
    renderManual({ act, row, i: index });
  } else if ((act === "fb-model" || act === "fb-effort") && selectedId) {
    catalogInteracting = false;
    takePendingCatalog();
    if (!row || !(ROLES as readonly string[]).includes(row)) return;
    const role = row as Role;
    const i = Number(t.dataset.i);
    const slot = currentSlot(role);
    const fallbacks = [...(slot.fallbacks ?? [])];
    const cur = fallbacks[i];
    if (!cur) return;
    if (act === "fb-model") fallbacks[i] = routeAfterUnifiedChange(catalog.models, t.value, cur.effort);
    else fallbacks[i] = routeAfterEffortChange(catalog.models, cur, t.value);
    draft = setSlot(draft, selectedId, taskType, role, { ...slot, fallbacks });
    renderManual({ act, row, i });
  }
}

rowsEl?.addEventListener("change", onControlChange);
rowsEl?.addEventListener("input", (ev) => {
  const t = ev.target as HTMLElement;
  if (t.getAttribute("data-act") === "search") onControlChange(ev);
});
leadRow?.addEventListener("change", onControlChange);
leadRow?.addEventListener("input", (ev) => {
  const t = ev.target as HTMLElement;
  if (t.getAttribute("data-act") === "search") onControlChange(ev);
});
advancedBody?.addEventListener("change", onControlChange);

manualFile?.addEventListener("change", async () => {
  const file = manualFile.files?.[0];
  manualFile.value = "";
  if (!file) return;
  const parsed = parseImportedJson(await file.text());
  if (!parsed.ok) return setManualStatus("error", "导入校验失败。", parsed.issues);
  selectedId = parsed.manual.profiles[0]?.id ?? selectedId;
  await doSave(parsed.manual);
});

const replyStatus = document.querySelector<HTMLElement>("#reply-status");
const replySeg = document.querySelector<HTMLElement>("#reply-seg");

function paintReply(mode: ReplyMode): void {
  replySeg?.querySelectorAll<HTMLButtonElement>("[data-reply]").forEach((b) => b.classList.toggle("on", b.dataset.reply === mode));
}

void (async () => {
  if (!replyStatus) return;
  try {
    const { mode, error } = readReplyMode(await io.getKv());
    paintReply(mode);
    replyStatus.textContent = error ?? "";
  } catch {
    replyStatus.textContent = "读取 /kv 失败，无法显示当前设置。";
  }
  replySeg?.addEventListener("click", async (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>("[data-reply]");
    if (!btn?.dataset.reply) return;
    const mode = btn.dataset.reply as ReplyMode;
    paintReply(mode);
    replyStatus.textContent = "正在保存…";
    try {
      const r = await saveReplyMode(io, mode);
      replyStatus.textContent = r.ok ? `已保存：${REPLY_MODE_LABELS[mode]}` : r.message;
    } catch (e) {
      replyStatus.textContent = e instanceof Error ? e.message : "保存失败。";
    }
  });
})();

void (async () => {
  if (!rowsEl) return;
  try {
    const loaded = await loadManualFromKv(io);
    loadInvalid = loaded.invalid === true;
    loadedFingerprint = loaded.fingerprint;
    if (loadInvalid) {
      draft = cloneManual(DEFAULT_MANUAL);
      baseline = cloneManual(DEFAULT_MANUAL);
      savedJson = JSON.stringify(draft);
      setManualStatus("error", `说明书无法读取，未覆盖已有内容：${loaded.error}`);
    } else {
      draft = loaded.manual;
      baseline = cloneManual(draft);
      savedJson = JSON.stringify(draft);
      selectedId = draft.defaults_by_harness[harness] ?? draft.profiles.find((p) => p.harness === harness)?.id;
      if (loaded.error) setManualStatus("error", loaded.error);
    }
  } catch {
    setManualStatus("error", "读取 /kv 失败，已使用默认方案。");
  }
  await refreshCatalog();
})();

const pageEvents = typeof window !== "undefined" && typeof window.addEventListener === "function";
if (pageEvents) {
  window.addEventListener("focus", () => { void refreshCatalog(); });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refreshCatalog();
  });
  setInterval(() => {
    if (typeof document !== "undefined" && document.hidden) return;
    void refreshCatalog();
  }, 5000);
}

export {};
