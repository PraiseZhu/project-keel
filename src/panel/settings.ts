// Settings page: the key is handed straight to the host vault (/secrets); never to /kv or logs.
import {
  addProfile,
  canDeleteProfile,
  cellView,
  copyProfile,
  deleteProfile,
  fetchCatalog,
  filterModels,
  HARNESS_LABELS,
  leadView,
  loadManualFromKv,
  materializeSlot,
  parseImportedJson,
  prettyExport,
  profileList,
  renameProfile,
  ROLE_LABELS,
  routeFromModel,
  saveManual,
  setDirectionGate,
  setHarnessDefault,
  setInherit,
  setLead,
  setProfileHarness,
  setSlot,
  TASK_LABELS,
  type CatalogState,
  type SettingsIO,
} from "./manual-editor.ts";
import { cloneManual, DEFAULT_MANUAL, HARNESSES, MAX_FALLBACKS, ROLES, TASK_TYPES, type DirectionGate, type Harness, type ModelManual, type Role, type Route, type Slot, type TaskType } from "../shared/manual/schema.ts";
import { renderClockStatus, renderStopHookStatus, type StopHookInstall } from "./hooks-status.ts";
import { readReplyMode, REPLY_MODE_LABELS, saveReplyMode, type ReplyMode } from "./reply-setting.ts";
import { parseKvResponse } from "../shared/kv-response.ts";
const input = document.querySelector<HTMLInputElement>("#key")!;
const statusEl = document.querySelector<HTMLElement>("#status")!;

async function refresh(): Promise<void> {
  const r = await fetch("/secrets");
  if (!r.ok) throw new Error("status");
  const entries = (await r.json()) as { key: string; saved: boolean; tail?: string }[];
  const key = entries.find((x) => x.key === "api_key");
  statusEl.textContent = key?.saved ? `凭证已保存${key.tail ? `（尾号 ${key.tail}）` : ""}` : "尚未配置凭证";
}

document.querySelector("#form")!.addEventListener("submit", async (event) => {
  event.preventDefault();
  const value = input.value.trim();
  input.value = "";
  if (!value) {
    statusEl.textContent = "请输入 API Key。";
    return;
  }
  try {
    const r = await fetch("/secrets/api_key", { method: "PUT", body: JSON.stringify({ value }) });
    if (r.status !== 204) throw new Error("save");
    await refresh();
  } catch {
    statusEl.textContent = "保存失败，请重新输入并重试。";
  }
});

document.querySelector("#clear")!.addEventListener("click", async () => {
  input.value = "";
  try {
    const r = await fetch("/secrets/api_key", { method: "DELETE" });
    if (!r.ok) throw new Error("clear");
    await refresh();
  } catch {
    statusEl.textContent = "清除失败，请重试。";
  }
});

// Lanes and paths are injected at build time from the personal profile (read-only here).
declare const __KEEL_PROFILE__: { lanes?: { repo: string; preset: string; preflight?: string; verifyCheck?: string }[]; routingPath?: string | null; plansDir?: string | null; boardRepos?: string[] };
const prof = typeof __KEEL_PROFILE__ === "undefined" ? {} : __KEEL_PROFILE__;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const lanesEl = document.querySelector<HTMLElement>("#lanes");
if (lanesEl) {
  const rows = (prof.lanes ?? []).map((l) => `<tr><td><code>${esc(l.repo)}</code></td><td>${esc(l.preset)}</td><td>${l.preflight ? "有" : "—"}</td><td>${l.verifyCheck ? `<code>${esc(l.verifyCheck)}</code>` : "—"}</td></tr>`).join("") || '<tr><td colspan="4">未配置，所有仓按 personal 车道处理</td></tr>';
  lanesEl.innerHTML = `<table><thead><tr><th>仓库</th><th>车道</th><th>推送前预检</th><th>验证状态</th></tr></thead><tbody>${rows}</tbody></table>
<p>派工路由：${prof.routingPath ? "已配置 routing.json" : "未配置（roles / fanout_plan 会 fail-closed）"}；计划目录：${prof.plansDir ? "已配置" : "目标仓 docs/"}；看板默认仓：${(prof.boardRepos ?? []).length} 个。</p>`;
}

// Live roles: ask main.js (same BroadcastChannel as the panel) to re-read routing.json.
const rolesEl = document.querySelector<HTMLElement>("#roles");
const rolesBtn = document.querySelector<HTMLButtonElement>("#roles-refresh");
const leadSel = document.querySelector<HTMLSelectElement>("#roles-lead");
if (rolesEl && rolesBtn && typeof BroadcastChannel !== "undefined") {
  const ch = new BroadcastChannel("keel");
  ch.addEventListener("message", (ev) => {
    const m = ev.data;
    if (m?.type !== "roles") return;
    if (m.message) return void (rolesEl.textContent = `读取失败：${m.message}`);
    const rows = Object.entries<any>(m.result?.roles ?? m.result ?? {}).filter(([, v]) => v && typeof v === "object" && v.model);
    rolesEl.innerHTML = rows.length ? `<table><thead><tr><th>角色</th><th>agent / 模型 / 强度</th><th>来源档</th></tr></thead><tbody>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v.agent)} / ${esc(v.model)} / ${esc(v.effort)}</td><td>${esc(v.tier)}</td></tr>`).join("")}</tbody></table>` : esc(JSON.stringify(m.result).slice(0, 400));
  });
  rolesBtn.addEventListener("click", async () => {
    rolesEl.textContent = "读取中…";
    try { await fetch("cindy-ghost://keel/wake"); } catch { /* already awake */ }
    const reqId = `roles-${Date.now()}`;
    for (let i = 0; i < 10; i++) { ch.postMessage({ reqId, op: "roles", lead_agent: leadSel?.value ?? "claude-code" }); await new Promise((r) => setTimeout(r, 400)); if (rolesEl.textContent !== "读取中…") break; }
  });
}

refresh().catch(() => {
  statusEl.textContent = "无法读取配置状态，请重新打开插件详情。";
});

const hooksEl = document.querySelector<HTMLElement>("#hooks-status");
const clockEl = document.querySelector<HTMLElement>("#clock-status");
if (hooksEl && typeof BroadcastChannel !== "undefined") {
  const ch = new BroadcastChannel("keel");
  ch.addEventListener("message", (ev) => {
    const m = ev.data as { type?: string; message?: string; result?: { claude_code?: string; codex?: string } };
    if (m?.type === "clock-status") {
      if (clockEl) clockEl.textContent = renderClockStatus(m.result as { state?: string; error?: string } | undefined);
      return;
    }
    if (m?.type !== "hooks-status") return;
    if (m.message) {
      hooksEl.textContent = `无法读取：${m.message}`;
      return;
    }
    const claude = m.result?.claude_code;
    const codex = m.result?.codex;
    const ok = (s: unknown): s is StopHookInstall => s === "installed" || s === "not_installed" || s === "unreadable";
    hooksEl.textContent = ok(claude) && ok(codex) ? renderStopHookStatus({ claude_code: claude, codex }) : "无法读取";
  });
  void (async () => {
    try { await fetch("cindy-ghost://keel/wake"); } catch { /* already awake */ }
    const reqId = `hooks-${Date.now()}`;
    for (let i = 0; i < 10; i++) {
      ch.postMessage({ reqId, op: "hooks-status" });
      ch.postMessage({ reqId: `clock-${reqId}`, op: "clock-status" });
      await new Promise((r) => setTimeout(r, 400));
      if (hooksEl.textContent !== "读取中…") break;
    }
  })();
}

const manualRoot = document.querySelector<HTMLElement>("#manual");
const manualStatus = document.querySelector<HTMLElement>("#manual-status");
const manualFile = document.querySelector<HTMLInputElement>("#manual-file");

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
let selectedId = draft.profiles[0]?.id ?? "";
let catalog: CatalogState = { status: "error", models: [], retry: false, message: "" };
let showHidden = false;

function setManualStatus(kind: "ok" | "error" | "info", text: string, issues?: { path: string; message: string }[]): void {
  if (!manualStatus) return;
  const extra = (issues ?? []).map((i) => `${i.path ? i.path + "：" : ""}${i.message}`).join("\n");
  manualStatus.className = kind === "ok" ? "ok" : kind === "error" ? "issues" : "hint";
  manualStatus.textContent = extra ? `${text}\n${extra}` : text;
}

function routeSelects(prefix: string, route: { agent: Harness; model: string; provider_id: string; effort?: string; stale?: string; modelOptions: readonly { value: string; label: string; hidden: boolean }[]; effortOptions: readonly { value: string; label: string }[] }): string {
  const agents = HARNESSES.map((h) => `<option value="${h}"${route.agent === h ? " selected" : ""}>${HARNESS_LABELS[h]}</option>`).join("");
  const models = route.modelOptions.map((o) => `<option value="${esc(o.value)}"${o.value === `${route.model}\t${route.provider_id}` ? " selected" : ""}>${esc(o.label)}${o.hidden ? "（隐藏）" : ""}</option>`).join("");
  const efforts = route.effortOptions.map((o) => `<option value="${esc(o.value)}"${(route.effort ?? "") === o.value ? " selected" : ""}>${esc(o.label)}</option>`).join("");
  return `<div class="cell-route${route.stale ? " stale" : ""}" data-prefix="${esc(prefix)}">
    <select data-act="agent" data-prefix="${esc(prefix)}">${agents}</select>
    <select data-act="model" data-prefix="${esc(prefix)}"><option value="">选择模型</option>${models}</select>
    <select data-act="effort" data-prefix="${esc(prefix)}">${efforts}</select>
    ${route.stale ? `<div class="stale-reason">${esc(route.stale)}</div>` : ""}
  </div>`;
}

function renderManual(): void {
  if (!manualRoot) return;
  const items = profileList(draft, selectedId);
  const selected = draft.profiles.find((p) => p.id === selectedId);
  const lead = selected ? leadView(draft, selected.id, catalog.models, showHidden) : undefined;
  const inheritOpts = draft.profiles.filter((p) => p.id !== selectedId).map((p) => `<option value="${esc(p.id)}"${selected?.inherit === p.id ? " selected" : ""}>${esc(p.name)}</option>`).join("");
  const profileBtns = items.map((p) => `<button type="button" data-act="select" data-id="${esc(p.id)}"${p.selected ? " class=\"on\"" : ""}>${esc(p.name)}${p.defaultOf ? ` · ${HARNESS_LABELS[p.defaultOf]}默认` : ""}</button>`).join("");
  let grid = "";
  if (selected) {
    const head = `<tr><th>节点</th>${TASK_TYPES.map((t) => `<th>${TASK_LABELS[t]}</th>`).join("")}</tr>`;
    const body = ROLES.map((role) => {
      const tds = TASK_TYPES.map((taskType) => {
        const cell = cellView(draft, selected.id, taskType, role, catalog.models, showHidden);
        const prefix = `slot:${taskType}:${role}`;
        if (cell.inherit) return `<td><label><input type="checkbox" data-act="cell-inherit" data-task="${taskType}" data-role="${role}" checked> 沿用</label></td>`;
        const fb = cell.fallbacks.map((f, i) => `<div>备${i + 1} ${routeSelects(`${prefix}:fb:${i}`, f)}<button type="button" data-act="del-fb" data-task="${taskType}" data-role="${role}" data-i="${i}">删备</button></div>`).join("");
        return `<td><label><input type="checkbox" data-act="cell-inherit" data-task="${taskType}" data-role="${role}"> 沿用</label>${routeSelects(`${prefix}:primary`, cell.primary!)}${fb}${cell.canAddFallback ? `<button type="button" data-act="add-fb" data-task="${taskType}" data-role="${role}">加备路线</button>` : ""}</td>`;
      }).join("");
      return `<tr><th>${ROLE_LABELS[role]}</th>${tds}</tr>`;
    }).join("");
    grid = `<div class="grid"><table>${head}${body}</table></div>`;
  }
  const catalogBar = catalog.message
    ? `<p class="issues">${esc(catalog.message)}${catalog.retry ? ` <button type="button" data-act="retry-catalog">重试</button>` : ""}</p>`
    : "";
  manualRoot.innerHTML = `${catalogBar}
    <div class="row"><label><input type="checkbox" data-act="toggle-hidden"${showHidden ? " checked" : ""}> 显示隐藏模型</label></div>
    <div class="row">${profileBtns}
      <button type="button" data-act="add">新增</button>
      <button type="button" data-act="copy">复制</button>
      <button type="button" data-act="delete">删除</button></div>
    ${selected && lead ? `<div class="row">名称 <input type="text" data-act="rename" value="${esc(selected.name)}">
      harness <select data-act="harness">${HARNESSES.map((h) => `<option value="${h}"${selected.harness === h ? " selected" : ""}>${HARNESS_LABELS[h]}</option>`).join("")}</select>
      方向裁决 <select data-act="direction"><option value="lead"${selected.direction_gate === "lead" ? " selected" : ""}>主控</option><option value="astra"${selected.direction_gate === "astra" ? " selected" : ""}>Astra</option></select>
      沿用方案 <select data-act="inherit"><option value="">不沿用</option>${inheritOpts}</select>
      <label><input type="checkbox" data-act="default"${draft.defaults_by_harness[selected.harness] === selected.id ? " checked" : ""}> 设为${HARNESS_LABELS[selected.harness]}默认</label></div>
      <p>主控</p>${routeSelects("lead", lead)}${grid}` : ""}
    <div class="row">
      <button type="button" data-act="save">保存说明书</button>
      <button type="button" data-act="export">导出 JSON</button>
      <button type="button" data-act="import">导入 JSON</button>
      <button type="button" data-act="restore">恢复默认方案</button></div>`;
}

function currentSlot(taskType: TaskType, role: Role): Slot {
  return draft.profiles.find((p) => p.id === selectedId)?.nodes[taskType]?.[role] ?? materializeSlot(draft, selectedId, taskType, role);
}

function writeRoute(slot: Slot, which: string, route: Route): Slot {
  if (which === "primary") return { ...slot, primary: route };
  const i = Number(which);
  const fallbacks = [...(slot.fallbacks ?? [])];
  fallbacks[i] = route;
  return { ...slot, fallbacks };
}

function applyRoute(prefix: string, next: Route): void {
  if (prefix === "lead") {
    draft = setLead(draft, selectedId, next);
    return;
  }
  const m = /^slot:([^:]+):([^:]+):(primary|fb):?(.*)$/.exec(prefix);
  if (!m) return;
  const taskType = m[1] as TaskType;
  const role = m[2] as Role;
  const which = m[3] === "primary" ? "primary" : m[4]!;
  draft = setSlot(draft, selectedId, taskType, role, writeRoute(currentSlot(taskType, role), which, next));
}

function readPrefixRoute(prefix: string): Route | undefined {
  if (prefix === "lead") return draft.profiles.find((p) => p.id === selectedId)?.lead;
  const m = /^slot:([^:]+):([^:]+):(primary|fb):?(.*)$/.exec(prefix);
  if (!m) return;
  const slot = currentSlot(m[1] as TaskType, m[2] as Role);
  return m[3] === "primary" ? slot.primary : slot.fallbacks?.[Number(m[4])];
}

async function doSave(next = draft): Promise<void> {
  setManualStatus("info", "正在保存…");
  let result: Awaited<ReturnType<typeof saveManual>>;
  try {
    result = await saveManual(io, next, catalog.models);
  } catch (e) {
    setManualStatus("error", `未写入：${e instanceof Error ? e.message : "读取 /kv 失败。"}`);
    return;
  }
  if (result.ok) {
    draft = next;
    if (!draft.profiles.some((p) => p.id === selectedId)) selectedId = draft.profiles[0]?.id ?? "";
    setManualStatus("ok", "已保存");
    renderManual();
    return;
  }
  if (result.kind === "invalid") setManualStatus("error", "校验未通过，未写入。", result.issues);
  else setManualStatus("error", result.message);
}

async function loadCatalog(): Promise<void> {
  catalog = await fetchCatalog(io);
  renderManual();
}

manualRoot?.addEventListener("click", (ev) => {
  const t = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]");
  if (!t) return;
  const act = t.dataset.act;
  if (act === "select") { selectedId = t.dataset.id ?? selectedId; renderManual(); }
  else if (act === "add") { const r = addProfile(draft); draft = r.manual; selectedId = r.id; renderManual(); }
  else if (act === "copy") { const r = copyProfile(draft, selectedId); draft = r.manual; selectedId = r.id; renderManual(); }
  else if (act === "delete") {
    const gate = canDeleteProfile(draft, selectedId);
    if (!gate.ok) return setManualStatus("error", gate.reason);
    const r = deleteProfile(draft, selectedId);
    if ("error" in r) return setManualStatus("error", r.error);
    draft = r.manual;
    selectedId = draft.profiles[0]?.id ?? "";
    renderManual();
  } else if (act === "add-fb") {
    const taskType = t.dataset.task as TaskType, role = t.dataset.role as Role;
    const slot = currentSlot(taskType, role);
    if ((slot.fallbacks ?? []).length >= MAX_FALLBACKS) return;
    const blank: Route = { agent: slot.primary.agent, model: "", provider_id: "" };
    draft = setSlot(draft, selectedId, taskType, role, { ...slot, fallbacks: [...(slot.fallbacks ?? []), blank] });
    renderManual();
  } else if (act === "del-fb") {
    const taskType = t.dataset.task as TaskType, role = t.dataset.role as Role, i = Number(t.dataset.i);
    const slot = currentSlot(taskType, role);
    const fallbacks = (slot.fallbacks ?? []).filter((_, idx) => idx !== i);
    draft = setSlot(draft, selectedId, taskType, role, { primary: slot.primary, fallbacks: fallbacks.length ? fallbacks : undefined });
    renderManual();
  } else if (act === "save") void doSave();
  else if (act === "export") {
    const blob = new Blob([prettyExport(draft)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "keel-manual.json";
    a.click();
    setManualStatus("info", "已导出当前说明书 JSON。");
  } else if (act === "import") manualFile?.click();
  else if (act === "restore") void doSave(cloneManual(DEFAULT_MANUAL));
  else if (act === "retry-catalog") void loadCatalog();
});

manualRoot?.addEventListener("change", (ev) => {
  const t = ev.target as HTMLInputElement | HTMLSelectElement;
  const act = t.dataset.act;
  if (act === "toggle-hidden") { showHidden = (t as HTMLInputElement).checked; renderManual(); }
  else if (act === "rename") { draft = renameProfile(draft, selectedId, t.value); }
  else if (act === "harness") { draft = setProfileHarness(draft, selectedId, t.value as Harness); renderManual(); }
  else if (act === "direction") { draft = setDirectionGate(draft, selectedId, t.value as DirectionGate); }
  else if (act === "inherit") { draft = setInherit(draft, selectedId, t.value || undefined); renderManual(); }
  else if (act === "default") { draft = setHarnessDefault(draft, selectedId, (t as HTMLInputElement).checked); renderManual(); }
  else if (act === "cell-inherit") {
    const taskType = t.dataset.task as TaskType, role = t.dataset.role as Role;
    if ((t as HTMLInputElement).checked) draft = setSlot(draft, selectedId, taskType, role, undefined);
    else draft = setSlot(draft, selectedId, taskType, role, materializeSlot(draft, selectedId, taskType, role));
    renderManual();
  } else if (act === "agent" || act === "model" || act === "effort") {
    const prefix = t.dataset.prefix ?? "";
    const cur = readPrefixRoute(prefix);
    if (!cur) return;
    if (act === "agent") {
      const agent = t.value as Harness;
      const first = filterModels(catalog.models, agent, showHidden)[0];
      applyRoute(prefix, first ? routeFromModel(first, cur.effort) : { agent, model: "", provider_id: "" });
      renderManual();
    } else if (act === "model") {
      const [id, providerId] = t.value.split("\t");
      const hit = catalog.models.find((m) => m.agent === cur.agent && m.id === id && m.providerId === providerId);
      applyRoute(prefix, hit ? routeFromModel(hit, cur.effort) : { agent: cur.agent, model: id ?? "", provider_id: providerId ?? "" });
      renderManual();
    } else {
      const hit = catalog.models.find((m) => m.agent === cur.agent && m.id === cur.model && m.providerId === cur.provider_id);
      applyRoute(prefix, hit ? routeFromModel(hit, t.value || undefined) : { ...cur, ...(t.value ? { effort: t.value } : { effort: undefined }) });
    }
  }
});

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

void (async () => {
  if (!replySelect || !replyStatus) return;
  try {
    const { mode, error } = readReplyMode(await io.getKv());
    replySelect.value = mode;
    replyStatus.textContent = error ?? `当前：${REPLY_MODE_LABELS[mode]}`;
  } catch {
    replyStatus.textContent = "读取 /kv 失败，无法显示当前设置。";
  }
  replySelect.addEventListener("change", async () => {
    const mode = replySelect.value as ReplyMode;
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
  if (!manualRoot) return;
  try {
    const loaded = await loadManualFromKv(io);
    draft = loaded.manual;
    selectedId = draft.profiles[0]?.id ?? "";
    if (loaded.error) setManualStatus("error", `已回落到默认方案：${loaded.error}`);
  } catch {
    setManualStatus("error", "读取 /kv 失败，已使用默认方案。");
  }
  await loadCatalog();
})();

export {};
