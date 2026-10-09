// Settings page: the key is handed straight to the host vault (/secrets); never to /kv or logs.
import {
  addProfile,
  canDeleteProfile,
  copyProfile,
  deleteProfile,
  fetchCatalog,
  HARNESS_LABELS,
  loadManualFromKv,
  materializeSlot,
  parseImportedJson,
  prettyExport,
  profileList,
  renameProfile,
  saveManual,
  setDirectionRoute,
  setFinalReviewRoute,
  setHarnessDefault,
  setInherit,
  setLead,
  setProfileHarness,
  setSlot,
  TASK_LABELS,
  type CatalogState,
  type SettingsIO,
} from "./manual-editor.ts";
import {
  acceptCatalogResponse,
  buildSettingsView,
  catalogArrivalAction,
  escapeHtml as esc,
  groupModelOptions,
  renderInheritOptionHtml,
  renderProfileButtonHtml,
  renderRowHtml,
  routeAfterAgentChange,
  routeAfterEffortChange,
  routeAfterModelChange,
  SETTINGS_ROW_IDS,
  shouldRefreshCatalogOnOpen,
  TASK_SCOPE_TYPES,
  type SettingsHarness,
  type SettingsRowId,
} from "./settings-model.ts";
import { cloneManual, DEFAULT_MANUAL, HARNESSES, MAX_FALLBACKS, type Harness, type ModelManual, type Role, type Route, type Slot, type TaskType } from "../shared/manual/schema.ts";
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
let harness: SettingsHarness = "codex";
let selectedId: string | undefined = draft.defaults_by_harness.codex;
let taskType: TaskType = "default";
let catalog: CatalogState = { status: "error", models: [], retry: false, message: "" };
let catalogSeq = 0;
let catalogInflight: Promise<CatalogState> | undefined;
let catalogInteracting = false;
let catalogProgrammaticFocus = false;
let pendingCatalog: CatalogState | undefined;

const input = document.querySelector<HTMLInputElement>("#key");
const statusEl = document.querySelector<HTMLElement>("#status");
const jevValue = document.querySelector<HTMLElement>("#status-jev-value");
const jevDot = document.querySelector<HTMLElement>("#status-jev-dot");

function setDot(el: HTMLElement | null, tone: "ok" | "warn" | "unknown"): void {
  if (!el) return;
  el.className = `dot ${tone}`;
}

async function refreshJev(): Promise<void> {
  if (!input && !jevValue && !statusEl) return;
  const r = await fetch("/secrets");
  if (!r.ok) throw new Error("status");
  const entries = (await r.json()) as { key: string; saved: boolean; tail?: string }[];
  const key = entries.find((x) => x.key === "api_key");
  const text = key?.saved ? `已保存${key.tail ? ` · 尾号 ${key.tail}` : ""}` : "尚未配置";
  if (statusEl) statusEl.textContent = key?.saved ? `凭证已保存${key.tail ? `（尾号 ${key.tail}）` : ""}` : "尚未配置凭证";
  if (jevValue) jevValue.textContent = text;
  setDot(jevDot, key?.saved ? "ok" : "warn");
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
    await refreshJev();
  } catch {
    statusEl.textContent = "保存失败，请重新输入并重试。";
  }
});

document.querySelector("#clear")?.addEventListener("click", async () => {
  if (input) input.value = "";
  try {
    const r = await fetch("/secrets/api_key", { method: "DELETE" });
    if (!r.ok) throw new Error("clear");
    await refreshJev();
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
  if (lanesSummary) lanesSummary.textContent = `只读 · ${n} 个仓 ›`;
  const rows = (prof.lanes ?? []).map((l) => `<tr><td><code>${esc(l.repo)}</code></td><td>${esc(l.preset)}</td><td>${l.preflight ? "有" : "—"}</td><td>${l.verifyCheck ? `<code>${esc(l.verifyCheck)}</code>` : "—"}</td></tr>`).join("") || '<tr><td colspan="4">未配置，所有仓按 personal 车道处理</td></tr>';
  lanesEl.innerHTML = `<table><thead><tr><th>仓库</th><th>车道</th><th>推送前预检</th><th>验证状态</th></tr></thead><tbody>${rows}</tbody></table>
<p>计划目录：${prof.plansDir ? "已配置" : "目标仓 docs/"}；看板默认仓：${(prof.boardRepos ?? []).length} 个。</p>`;
}

refreshJev().catch(() => {
  if (statusEl) statusEl.textContent = "无法读取配置状态，请重新打开插件详情。";
  if (jevValue) jevValue.textContent = "无法读取";
  setDot(jevDot, "unknown");
});

const hooksBox = document.querySelector<HTMLElement>("#status-hooks-value");
const clockValue = document.querySelector<HTMLElement>("#status-clock-value");
const clockDot = document.querySelector<HTMLElement>("#status-clock-dot");
if (hooksBox && typeof BroadcastChannel !== "undefined") {
  const ch = new BroadcastChannel("keel");
  ch.addEventListener("message", (ev) => {
    const m = ev.data as { type?: string; message?: string; result?: { claude_code?: string; codex?: string; state?: string; error?: string; failCount?: number } };
    if (m?.type === "clock-status") {
      const tone = clockTone(m.result);
      if (clockValue) clockValue.textContent = renderClockStatus(m.result).replace(/^常驻时钟：/, "");
      setDot(clockDot, tone);
      return;
    }
    if (m?.type !== "hooks-status") return;
    if (m.message) {
      hooksBox.innerHTML = `<div class="v"><i class="dot unknown"></i>无法读取</div>`;
      return;
    }
    const claude = m.result?.claude_code;
    const codex = m.result?.codex;
    const ok = (s: unknown): s is StopHookInstall => s === "installed" || s === "not_installed" || s === "unreadable";
    if (!ok(claude) || !ok(codex)) {
      hooksBox.innerHTML = `<div class="v"><i class="dot unknown"></i>无法读取</div>`;
      return;
    }
    const hookLabel = (s: StopHookInstall) => s === "installed" ? "已装" : s === "not_installed" ? "未装" : "无法读取";
    hooksBox.innerHTML = `<div class="v"><i class="dot ${stopHookTone(codex)}"></i>Codex ${hookLabel(codex)}</div>
<div class="v"><i class="dot ${stopHookTone(claude)}"></i>Claude Code ${hookLabel(claude)}</div>`;
  });
  void (async () => {
    try { await fetch("cindy-ghost://keel/wake"); } catch { /* already awake */ }
    const reqId = `hooks-${Date.now()}`;
    for (let i = 0; i < 10; i++) {
      ch.postMessage({ reqId, op: "hooks-status" });
      ch.postMessage({ reqId: `clock-${reqId}`, op: "clock-status" });
      await new Promise((r) => setTimeout(r, 400));
      if (!hooksBox.textContent?.includes("读取中")) break;
    }
  })();
}

const manualStatus = document.querySelector<HTMLElement>("#manual-status");
const manualFile = document.querySelector<HTMLInputElement>("#manual-file");
const rowsEl = document.querySelector<HTMLElement>("#model-rows");
const taskbar = document.querySelector<HTMLElement>("#taskbar");
const hintEl = document.querySelector<HTMLElement>("#model-hint");
const catalogValue = document.querySelector<HTMLElement>("#status-catalog-value");
const catalogDot = document.querySelector<HTMLElement>("#status-catalog-dot");
const advancedBody = document.querySelector<HTMLElement>("#advanced-body");

function setManualStatus(kind: "ok" | "error" | "info", text: string, issues?: { path: string; message: string }[]): void {
  if (!manualStatus) return;
  const extra = (issues ?? []).map((i) => `${i.path ? i.path + "：" : ""}${i.message}`).join("\n");
  manualStatus.className = kind === "ok" ? "ok" : kind === "error" ? "issues" : "hint";
  manualStatus.textContent = extra ? `${text}\n${extra}` : text;
}

function currentView() {
  return buildSettingsView(draft, { harness, profileId: selectedId, taskType }, catalog.models);
}

function renderAdvanced(view: ReturnType<typeof currentView>): void {
  if (!advancedBody) return;
  const items = profileList(draft, view.profileId);
  const selected = draft.profiles.find((p) => p.id === view.profileId);
  const inheritOpts = draft.profiles.filter((p) => p.id !== view.profileId).map((p) => renderInheritOptionHtml(p, selected?.inherit)).join("");
  const profileBtns = items.map((p) => renderProfileButtonHtml(p)).join("");
  let fallbacks = "";
  if (selected) {
    const col = selected.nodes[taskType === "default" ? "default" : taskType] ?? selected.nodes.default;
    const roles: Role[] = ["explorer", "researcher", "worker", "verifier", "architect"];
    fallbacks = roles.map((role) => {
      const slot = col?.[role];
      const fbs = slot?.fallbacks ?? [];
      const groups = slot ? groupModelOptions(catalog.models, slot.primary.agent) : [];
      const fbHtml = fbs.map((f, i) => {
        const g = groupModelOptions(catalog.models, f.agent);
        const modelOpts = g.map((x) => `<optgroup label="${esc(x.label)}">${x.options.map((o) => `<option value="${esc(o.value)}"${o.value === `${f.model}\t${f.provider_id}` ? " selected" : ""}>${esc(o.label)}</option>`).join("")}</optgroup>`).join("");
        const efforts = (catalog.models.find((m) => m.agent === f.agent && m.id === f.model && m.providerId === f.provider_id)?.efforts ?? []).map((e) => `<option${e === f.effort ? " selected" : ""}>${esc(e)}</option>`).join("");
        return `<div class="adv-row">备${i + 1}
          <select data-act="fb-agent" data-role="${role}" data-i="${i}">${HARNESSES.map((h) => `<option value="${h}"${f.agent === h ? " selected" : ""}>${HARNESS_LABELS[h]}</option>`).join("")}</select>
          <select data-act="fb-model" data-role="${role}" data-i="${i}">${modelOpts}</select>
          <select data-act="fb-effort" data-role="${role}" data-i="${i}">${efforts}</select>
          <button type="button" data-act="del-fb" data-role="${role}" data-i="${i}">删备</button></div>`;
      }).join("");
      return `<p>${role}${groups.length ? "" : ""}</p>${fbHtml}${slot && fbs.length < MAX_FALLBACKS ? `<button type="button" data-act="add-fb" data-role="${role}">加备路线</button>` : ""}`;
    }).join("");
  }
  advancedBody.innerHTML = `<p class="hint">档次表只用于方向裁决分组（比主控强 / 持平 / 未分级），不能在这里增删模型。</p>
    <div class="adv-row">${profileBtns}
      <button type="button" data-act="add">新增</button>
      <button type="button" data-act="copy">复制</button>
      <button type="button" data-act="delete">删除</button></div>
    ${selected ? `<div class="adv-row">名称 <input type="text" data-act="rename" value="${esc(selected.name)}">
      harness <select data-act="adv-harness">${HARNESSES.map((h) => `<option value="${h}"${selected.harness === h ? " selected" : ""}>${HARNESS_LABELS[h]}</option>`).join("")}</select>
      沿用方案 <select data-act="inherit"><option value="">不沿用</option>${inheritOpts}</select>
      <label><input type="checkbox" data-act="default"${draft.defaults_by_harness[selected.harness] === selected.id ? " checked" : ""}> 设为${HARNESS_LABELS[selected.harness]}默认</label></div>` : ""}
    <div class="adv-row">
      <button type="button" data-act="export">导出 JSON</button>
      <button type="button" data-act="import">导入 JSON</button></div>
    ${fallbacks}`;
}

function renderManual(restore?: { act: string; row: string }): void {
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
  if (hintEl) {
    hintEl.textContent = view.taskScope === "task"
      ? `只改需要和「所有任务」不同的角色。已有 ${view.overrideCount} 处覆盖。`
      : (view.notice ?? "改完点保存，下一次派工生效。");
  }
  if (catalogValue) {
    if (catalog.status === "ok") {
      const n = catalog.models.filter((m) => m.visible === true).length;
      catalogValue.textContent = catalog.models.length ? `已启用 ${n} 项` : "清单为空";
      setDot(catalogDot, catalog.models.length ? "ok" : "warn");
    } else {
      catalogValue.textContent = catalog.status === "upgrade" ? "需升级 Cindy" : catalog.status === "retry" ? "暂时不可用" : "读取失败";
      setDot(catalogDot, "warn");
    }
  }
  if (rowsEl) {
    if (view.empty) rowsEl.innerHTML = `<div class="empty">${esc(view.empty)}</div>`;
    else rowsEl.innerHTML = view.rows.map((row) => renderRowHtml(row, taskType)).join("");
  }
  renderAdvanced(view);
  if (restore && rowsEl) {
    catalogProgrammaticFocus = true;
    try {
      const el = rowsEl.querySelector<HTMLElement>(`[data-act="${restore.act}"][data-row="${restore.row}"]`);
      if (el && typeof el.focus === "function" && !(el as HTMLSelectElement).disabled) el.focus();
    } finally {
      catalogProgrammaticFocus = false;
    }
  }
}

function focusedModelControl(): { act: string; row: string } | undefined {
  const el = document.activeElement;
  if (!el || !rowsEl?.contains(el)) return undefined;
  if (el.tagName !== "SELECT") return undefined;
  const act = el.getAttribute("data-act");
  const row = el.getAttribute("data-row");
  if (act !== "agent" && act !== "model" && act !== "effort") return undefined;
  if (!row || !(SETTINGS_ROW_IDS as readonly string[]).includes(row)) return undefined;
  return { act, row };
}

function currentSlot(role: Role): Slot {
  const id = selectedId ?? "";
  return draft.profiles.find((p) => p.id === id)?.nodes[taskType]?.[role]
    ?? draft.profiles.find((p) => p.id === id)?.nodes.default?.[role]
    ?? materializeSlot(draft, id, taskType, role);
}

function applyRowRoute(row: SettingsRowId, next: Route): void {
  if (!selectedId) return;
  if (row === "lead") {
    draft = setLead(draft, selectedId, next);
    return;
  }
  if (row === "direction") {
    draft = setDirectionRoute(draft, selectedId, next.model && next.provider_id ? next : undefined);
    return;
  }
  if (row === "final-review") {
    draft = setFinalReviewRoute(draft, selectedId, next.model && next.provider_id ? next : undefined);
    return;
  }
  const role = row as Role;
  const target: TaskType = taskType === "default" ? "default" : taskType;
  const prev = currentSlot(role);
  draft = setSlot(draft, selectedId, target, role, { primary: next, fallbacks: prev.fallbacks });
}

async function doSave(next = draft): Promise<void> {
  setManualStatus("info", "正在保存…");
  await refreshCatalog({ render: false });
  let result: Awaited<ReturnType<typeof saveManual>>;
  try {
    result = await saveManual(io, next, catalog.models);
  } catch (e) {
    setManualStatus("error", `未写入：${e instanceof Error ? e.message : "读取 /kv 失败。"}`);
    return;
  }
  if (result.ok) {
    draft = next;
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
rowsEl?.addEventListener("focusout", (ev) => {
  if (!rowsEl) return;
  const related = (ev as FocusEvent).relatedTarget as Node | null;
  if (related && rowsEl.contains(related)) return;
  endSelectInteraction();
});

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
  } else if (act === "add-fb" && selectedId) {
    const role = t.dataset.role as Role;
    const slot = currentSlot(role);
    if ((slot.fallbacks ?? []).length >= MAX_FALLBACKS) return;
    const blank: Route = { agent: slot.primary.agent, model: "", provider_id: "" };
    draft = setSlot(draft, selectedId, taskType === "default" ? "default" : taskType, role, { ...slot, fallbacks: [...(slot.fallbacks ?? []), blank] });
    renderManual();
  } else if (act === "del-fb" && selectedId) {
    const role = t.dataset.role as Role;
    const i = Number(t.dataset.i);
    const slot = currentSlot(role);
    const fallbacks = (slot.fallbacks ?? []).filter((_, idx) => idx !== i);
    draft = setSlot(draft, selectedId, taskType === "default" ? "default" : taskType, role, { primary: slot.primary, fallbacks: fallbacks.length ? fallbacks : undefined });
    renderManual();
  }
}

document.querySelector(".bar")?.addEventListener("click", onActClick);
advancedBody?.addEventListener("click", onActClick);
rowsEl?.addEventListener("click", onActClick);

function onControlChange(ev: Event): void {
  const t = ev.target as HTMLInputElement | HTMLSelectElement;
  const act = t.dataset.act;
  const row = t.dataset.row as SettingsRowId | undefined;
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
  } else if ((act === "agent" || act === "model" || act === "effort") && row) {
    catalogInteracting = false;
    takePendingCatalog();
    const view = currentView();
    const cur = view.rows.find((r) => r.id === row);
    if (row === "direction" && act === "model" && t.value === "") {
      if (selectedId) draft = setDirectionRoute(draft, selectedId, undefined);
      renderManual({ act, row });
      return;
    }
    if (row === "final-review" && act === "model" && t.value === "") {
      if (selectedId) draft = setFinalReviewRoute(draft, selectedId, undefined);
      renderManual({ act, row });
      return;
    }
    const prev = cur?.route ?? {
      agent: ((cur?.agent.value as Harness) || "codex"),
      model: "",
      provider_id: "",
    };
    let next: Route;
    if (act === "agent") next = routeAfterAgentChange(catalog.models, t.value as Harness, prev.effort);
    else if (act === "model") {
      const [id, providerId] = t.value.split("\t");
      next = routeAfterModelChange(catalog.models, prev.agent, id ?? "", providerId ?? "", prev.effort);
    } else next = routeAfterEffortChange(catalog.models, prev, t.value);
    applyRowRoute(row, next);
    renderManual({ act, row });
  } else if ((act === "fb-agent" || act === "fb-model" || act === "fb-effort") && selectedId) {
    const role = t.dataset.role as Role;
    const i = Number(t.dataset.i);
    const slot = currentSlot(role);
    const fallbacks = [...(slot.fallbacks ?? [])];
    const cur = fallbacks[i];
    if (!cur) return;
    if (act === "fb-agent") fallbacks[i] = routeAfterAgentChange(catalog.models, t.value as Harness, cur.effort);
    else if (act === "fb-model") {
      const [id, providerId] = t.value.split("\t");
      fallbacks[i] = routeAfterModelChange(catalog.models, cur.agent, id ?? "", providerId ?? "", cur.effort);
    } else fallbacks[i] = routeAfterEffortChange(catalog.models, cur, t.value);
    draft = setSlot(draft, selectedId, taskType === "default" ? "default" : taskType, role, { ...slot, fallbacks });
    renderManual();
  }
}

rowsEl?.addEventListener("change", onControlChange);
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

const replySelect = document.querySelector<HTMLSelectElement>("#reply-confirm");
const replyStatus = document.querySelector<HTMLElement>("#reply-status");
const replySeg = document.querySelector<HTMLElement>("#reply-seg");

function paintReply(mode: ReplyMode): void {
  if (replySelect) replySelect.value = mode;
  replySeg?.querySelectorAll<HTMLButtonElement>("[data-reply]").forEach((b) => b.classList.toggle("on", b.dataset.reply === mode));
}

void (async () => {
  if (!replyStatus) return;
  try {
    const { mode, error } = readReplyMode(await io.getKv());
    paintReply(mode);
    replyStatus.textContent = error ?? `当前：${REPLY_MODE_LABELS[mode]}`;
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
    draft = loaded.manual;
    selectedId = draft.defaults_by_harness[harness] ?? draft.profiles.find((p) => p.harness === harness)?.id;
    if (loaded.error) setManualStatus("error", `已回落到默认方案：${loaded.error}`);
  } catch {
    setManualStatus("error", "读取 /kv 失败，已使用默认方案。");
  }
  await refreshCatalog();
})();

export {};
