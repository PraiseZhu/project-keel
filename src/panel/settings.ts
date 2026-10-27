// Settings page: the key is handed straight to the host vault (/secrets); never to /kv or logs.
import {
  fetchCatalog,
  fingerprintManual,
  loadManualFromKv,
  parseImportedJson,
  prettyExport,
  saveManual,
  withSavedVersion,
  type CatalogState,
  type SettingsIO,
} from "./manual-editor.ts";
import {
  acceptCatalogResponse,
  addDefaultProfile,
  applyStageChange,
  buildStageView,
  catalogArrivalAction,
  escapeHtml as esc,
  isCatalogReady,
  isSelectAct,
  isSlotId,
  isStageId,
  renderStageRowsHtml,
  shouldRefreshCatalogOnOpen,
  type SlotId,
} from "./stage-settings.ts";
import { isStageHarness, stripRetiredFields, type StageHarness, type StageId } from "../shared/manual/stages.ts";
import { cloneManual, DEFAULT_MANUAL, type ModelManual } from "../shared/manual/schema.ts";
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
  async getAgentModels(url = "/agent-models") {
    const r = await fetch(url);
    let body: unknown;
    try { body = await r.json(); } catch { body = undefined; }
    return { status: r.status, body };
  },
  broadcast(message) {
    if (typeof BroadcastChannel !== "undefined") new BroadcastChannel("keel").postMessage(message);
  },
};

// state
let draft: ModelManual = cloneManual(DEFAULT_MANUAL);
let baseline: ModelManual = cloneManual(DEFAULT_MANUAL);
let loadedFingerprint = "";
let loadInvalid = false;
let harness: StageHarness = "claude-code";
let stageNotice = "";
let problemCount = 0;
let catalog: CatalogState = { status: "error", models: [], retry: false, message: "" };
let catalogSeq = 0;
let catalogInflight: Promise<CatalogState> | undefined;
let catalogInteracting = false;
let catalogProgrammaticFocus = false;
let pendingCatalog: CatalogState | undefined;

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

// manual form
const manualStatus = document.querySelector<HTMLElement>("#manual-status");
const manualFile = document.querySelector<HTMLInputElement>("#manual-file");
const rowsEl = document.querySelector<HTMLElement>("#model-rows");
const noticeEl = document.querySelector<HTMLElement>("#stage-notice");
const saveBtn = document.querySelector<HTMLButtonElement>("[data-act=\"save\"]");
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
  if (saveBtn) saveBtn.disabled = !dirty || loadInvalid || problemCount > 0;
  if (!manualStatus || manualStatus.className === "issues") return;
  if (loadInvalid) return;
  if (dirty) setManualStatus("info", UNSAVED);
  else if (manualStatus.textContent === UNSAVED) setManualStatus("info", "");
}

function currentView() {
  return buildStageView(draft, harness, catalog.models, isCatalogReady(catalog), catalog.catalogNote);
}

function paintCatalogStatus(): void {
  if (catalog.status === "ok") {
    const n = catalog.models.filter((m) => m.visible !== false).length;
    setStatus("catalog", n ? "ok" : "warn", n ? "" : "为空", `模型清单：已启用 ${n} 项`);
    return;
  }
  const problem = catalog.status === "upgrade" ? "需升级 Cindy" : catalog.status === "retry" ? "暂时不可用" : "读取失败";
  setStatus("catalog", "warn", problem, catalog.message || `模型清单：${problem}`);
}

interface ControlRef { act: string; stage: StageId; slot: SlotId }

function renderManual(restore?: ControlRef): void {
  const view = currentView();
  problemCount = view.problemCount;
  document.querySelectorAll<HTMLButtonElement>("#model-tabs [data-harness]").forEach((b) => {
    const on = b.dataset.harness === harness;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  if (noticeEl) noticeEl.textContent = stageNotice;
  paintCatalogStatus();
  if (rowsEl) rowsEl.innerHTML = renderStageRowsHtml(view);
  paintDirty();
  if (!restore || !rowsEl) return;
  catalogProgrammaticFocus = true;
  try {
    const el = document.querySelector<HTMLElement>(`[data-act="${restore.act}"][data-stage="${restore.stage}"][data-slot="${restore.slot}"]`);
    if (el && typeof el.focus === "function" && !(el as HTMLSelectElement).disabled) el.focus();
  } finally {
    catalogProgrammaticFocus = false;
  }
}

function focusedModelControl(): ControlRef | undefined {
  const el = document.activeElement;
  if (!el || !rowsEl?.contains(el) || el.tagName !== "SELECT") return undefined;
  const act = el.getAttribute("data-act");
  const stage = el.getAttribute("data-stage");
  const slot = el.getAttribute("data-slot");
  if (!isSelectAct(act) || !isStageId(stage) || !isSlotId(slot)) return undefined;
  return { act, stage, slot };
}

async function doSave(next = draft): Promise<void> {
  if (loadInvalid && next !== draft && JSON.stringify(next) !== JSON.stringify(DEFAULT_MANUAL) && JSON.stringify(next) !== JSON.stringify(withSavedVersion(DEFAULT_MANUAL))) {
    setManualStatus("error", "说明书无法读取，未覆盖已有内容。请先恢复默认或修好 JSON 再保存。");
    return;
  }
  setManualStatus("info", "正在保存…");
  await refreshCatalog({ render: false });
  const toSave = stripRetiredFields(next);
  let result: Awaited<ReturnType<typeof saveManual>>;
  try {
    result = await saveManual(io, toSave, catalog.models, { expectedFingerprint: loadedFingerprint, baseline });
  } catch (e) {
    setManualStatus("error", `未写入：${e instanceof Error ? e.message : "读取 /kv 失败。"}`);
    return;
  }
  if (result.ok) {
    draft = withSavedVersion(toSave);
    baseline = cloneManual(draft);
    savedJson = JSON.stringify(draft);
    loadedFingerprint = fingerprintManual(draft);
    loadInvalid = false;
    stageNotice = "";
    setManualStatus("ok", "已保存");
    renderManual();
    return;
  }
  if (result.kind === "invalid") setManualStatus("error", "校验未通过，未写入。", result.issues);
  else setManualStatus("error", result.message);
}

// catalog arrival: a late response must not rebuild a select the user is operating
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
  const related = (ev as FocusEvent).relatedTarget as Node | null;
  if (related && rowsEl.contains(related)) return;
  endSelectInteraction();
});

// events
document.querySelector("#model-tabs")?.addEventListener("click", (ev) => {
  const next = (ev.target as HTMLElement).closest<HTMLElement>("[data-harness]")?.dataset.harness;
  if (!isStageHarness(next)) return;
  harness = next;
  stageNotice = "";
  renderManual();
});

function onActClick(ev: Event): void {
  const act = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
  if (act === "save") void doSave();
  else if (act === "restore") void doSave(cloneManual(DEFAULT_MANUAL));
  else if (act === "import") manualFile?.click();
  else if (act === "use-default") {
    draft = addDefaultProfile(draft, harness);
    stageNotice = "";
    renderManual();
  } else if (act === "export") {
    const blob = new Blob([prettyExport(draft)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "keel-manual.json";
    a.click();
    setManualStatus("info", "已导出当前说明书 JSON。");
  }
}

document.querySelector(".bar")?.addEventListener("click", onActClick);
document.querySelector("#advanced-body")?.addEventListener("click", onActClick);
rowsEl?.addEventListener("click", onActClick);

rowsEl?.addEventListener("change", (ev) => {
  const t = ev.target as HTMLSelectElement;
  const act = t.dataset.act;
  const stage = t.dataset.stage;
  const slot = t.dataset.slot;
  if (!isSelectAct(act) || !isStageId(stage) || !isSlotId(slot)) return;
  catalogInteracting = false;
  takePendingCatalog();
  const result = applyStageChange(draft, harness, catalog.models, { stage, slot, act, value: t.value });
  draft = result.manual;
  stageNotice = result.notice ?? "";
  renderManual({ act, stage, slot });
});

manualFile?.addEventListener("change", async () => {
  const file = manualFile.files?.[0];
  manualFile.value = "";
  if (!file) return;
  const parsed = parseImportedJson(await file.text());
  if (!parsed.ok) return setManualStatus("error", "导入校验失败。", parsed.issues);
  stageNotice = "";
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


// load
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
