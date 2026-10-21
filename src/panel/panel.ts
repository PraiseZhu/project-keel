import { BOARD_COLUMNS, BOARD_REFRESH_MS, pullUrl, type BoardCard, type BoardStage } from "../shared/dashboard.ts";
import { activityOf, ageLabel, applyDashboardMessage, cardState, emptyDashboard, filteredCards, type DashboardFilters } from "./dashboard-model.ts";
import { cardBody, dashboardMarkup, escapeHtml, heading, icon, vigilDetails } from "./dashboard-render.ts";

const root = document.querySelector<HTMLElement>("#dashboard-root")!;
root.innerHTML = dashboardMarkup();
const select = <ElementType extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<ElementType>(selector)!;
const board = select(".kb");
const viewport = select(".board-scroll");
const header = select(".board-header-viewport");
const headerTrack = select(".board-header-track");
const columns = select(".columns");
const search = select<HTMLInputElement>("#board-search");
const repoList = select("#repo-list");
const repoTrigger = select<HTMLButtonElement>("#repo-filter");
const detailDialog = select<HTMLDialogElement>("#pr-detail");
const motion = matchMedia("(prefers-reduced-motion: reduce)");
const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("keel") : null;
const panelId = `board-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
let store = emptyDashboard();
let filters: DashboardFilters = { repo: "all", query: "", filter: "all", stage: null };
let focusedStage: BoardStage | null = null;
let maximumPerColumn = 40;
let refreshing = false;
let refreshTimer: number | undefined;
let renderFrame: number | undefined;
let transportError = "";
let trackingWarning = "";
let selectedKey: string | null = null;
let detailContext = "";
let detailRequestId: string | undefined;
let returnFocus: HTMLElement | null = null;
let disposed = false;
const elements = new Map<string, HTMLElement>();
const bodies = new Map<string, string>();
const movement = new Map<HTMLElement, Animation>();
const pending = new Map<string, { timeout: number; retry?: number; op: string }>();
const numbers = new Map<HTMLElement, number>();

for (const [index, column] of BOARD_COLUMNS.entries()) {
  const cell = document.createElement("div");
  cell.className = `header-cell flow-${column.id === "local" ? "local" : column.id === "cloud" ? "loop" : "branch"}`;
  cell.dataset.headerColumn = column.id;
  cell.innerHTML = heading(column, 0, false);
  headerTrack.append(cell);
  const section = document.createElement("section");
  section.className = "column";
  section.dataset.column = column.id;
  section.style.setProperty("--c", String(index));
  section.innerHTML = `${heading(column, 0, false)}<div class="column-cards"></div><div class="column-empty">暂无 PR</div><button type="button" class="load-more" data-load-more hidden></button>`;
  columns.append(section);
}

function canAnimate(): boolean {
  return !motion.matches && document.visibilityState !== "hidden" && store.connection !== "offline" && !transportError && !!store.lastSuccessAt && !(store.retryAt && store.retryAt > Date.now());
}

function number(element: HTMLElement, value: number): void {
  const before = numbers.get(element);
  if (before === value) return;
  numbers.set(element, value);
  element.textContent = String(value);
  element.classList.toggle("has-items", value > 0);
  if (before !== undefined && canAnimate()) {
    element.classList.remove("tick-up", "tick-down");
    requestAnimationFrame(() => element.classList.add(value < before ? "tick-down" : "tick-up"));
  }
}

function geometry(): void {
  const sections = Array.from(columns.querySelectorAll<HTMLElement>(".column"));
  const layout = getComputedStyle(columns);
  const stacked = layout.display === "flex" && layout.flexDirection === "column";
  const widths = columns.hidden || layout.display === "none" || stacked ? [] : sections.map((section) => section.getBoundingClientRect().width);
  header.hidden = widths.length !== BOARD_COLUMNS.length || widths.some((width) => !Number.isFinite(width) || width <= 0);
  if (!header.hidden) {
    headerTrack.style.gap = layout.columnGap;
    headerTrack.style.gridTemplateColumns = widths.map((width) => `${width}px`).join(" ");
    headerTrack.style.width = `${columns.scrollWidth}px`;
    header.scrollLeft = viewport.scrollLeft;
  } else {
    headerTrack.style.removeProperty("grid-template-columns");
    headerTrack.style.removeProperty("width");
  }
  const tabs = select(".filter-tabs");
  tabs.classList.toggle("thumb-animate", canAnimate());
  const selected = tabs.querySelector<HTMLElement>(".filter-tab.selected");
  if (selected) { tabs.style.setProperty("--thumb-x", `${selected.offsetLeft}px`); tabs.style.setProperty("--thumb-w", `${selected.offsetWidth}px`); }
}

function updateRepos(): void {
  if (!repoList.hidden) return;
  const repos = new Map<string, number>();
  for (const row of store.rows.values()) repos.set(row.repo, (repos.get(row.repo) ?? 0) + 1);
  const options = [["all", "所有仓库", store.rows.size], ...[...repos].sort(([left], [right]) => left.localeCompare(right)).map(([repo, count]) => [repo, repo, count])];
  repoList.innerHTML = options.map(([value, label, count]) => `<button type="button" role="menuitemradio" class="repo-option" data-repo="${escapeHtml(value)}" aria-checked="${filters.repo === value}"><span class="opt-check">${icon("check")}</span><span class="opt-label">${escapeHtml(label)}</span><span class="opt-count">${count}</span></button>`).join("");
  repoTrigger.querySelector(".repo-trigger-label")!.textContent = filters.repo === "all" ? "所有仓库" : filters.repo;
}

function render(): void {
  renderFrame = undefined;
  if (disposed) return;
  const now = Date.now();
  const rows = filteredCards(store, { ...filters, stage: null }, now);
  const all = [...store.rows.values()];
  const oldRects = new Map([...elements].map(([key, element]) => [key, element.getBoundingClientRect()]));
  const visible = new Set<string>();
  const counts = {
    all: all.length,
    running: all.filter((row) => row.runId && ["running", "waiting"].includes(activityOf(row, now))).length,
    attention: all.filter((row) => activityOf(row, now) === "needs-human").length,
  };
  board.classList.toggle("reduce-motion", motion.matches);
  board.classList.toggle("offline-mode", !canAnimate());
  board.classList.toggle("stale-mode", store.connection === "offline" || Boolean(transportError));
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>("[data-filter]"))) {
    const key = button.dataset.filter as DashboardFilters["filter"];
    button.classList.toggle("selected", key === filters.filter);
    button.setAttribute("aria-pressed", String(key === filters.filter));
    number(button.querySelector<HTMLElement>(".count")!, counts[key]);
  }
  for (const column of BOARD_COLUMNS) {
    const section = columns.querySelector<HTMLElement>(`[data-column="${column.id}"]`)!;
    const cell = headerTrack.querySelector<HTMLElement>(`[data-header-column="${column.id}"]`)!;
    const selectedRows = rows.filter((row) => row.stage === column.id);
    for (const container of [section, cell]) {
      number(container.querySelector<HTMLElement>(".column-count")!, selectedRows.length);
      container.classList.toggle("stage-focused", focusedStage === column.id);
      container.classList.toggle("is-live", canAnimate() && selectedRows.some((row) => activityOf(row, now) === "running"));
      container.querySelector("[data-flow-node]")?.setAttribute("aria-pressed", String(focusedStage === column.id));
    }
    const list = section.querySelector<HTMLElement>(".column-cards")!;
    for (const [index, row] of selectedRows.slice(0, maximumPerColumn).entries()) {
      visible.add(row.key);
      let element = elements.get(row.key);
      const fresh = !element;
      if (!element) {
        element = document.createElement("article");
        element.className = "pr-card";
        element.dataset.key = row.key;
        elements.set(row.key, element);
      }
      const { activity, status } = cardState(row, now);
      const fingerprint = JSON.stringify([row.title, row.sessionLabel, row.state, row.isDraft, row.stage, activity, row.status, row.detail, row.step, row.error, row.headSha, row.ci]);
      if (bodies.get(row.key) !== fingerprint) {
        const focus = element.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.action : undefined;
        element.innerHTML = cardBody(row, now);
        bodies.set(row.key, fingerprint);
        if (!fresh && canAnimate()) {
          element.classList.remove("received");
          requestAnimationFrame(() => element!.classList.add("received"));
        }
        if (focus) element.querySelector<HTMLElement>(`[data-action="${focus}"]`)?.focus({ preventScroll: true });
      }
      element.dataset.stage = row.stage;
      element.dataset.activity = activity;
      element.dataset.human = String(activity === "needs-human");
      element.classList.toggle("is-human", activity === "needs-human");
      element.classList.toggle("is-stale", activity === "stale");
      element.classList.toggle("new-card", fresh && canAnimate());
      element.style.setProperty("--i", String(Math.min(index, 6)));
      element.style.setProperty("--delay", `${Math.min(index * 18, 100)}ms`);
      element.setAttribute("aria-label", `${row.repo} #${row.number}，${status}`);
      const time = element.querySelector<HTMLElement>("time[data-time]");
      if (time) {
        const timestamp = row.activityAt ?? (Date.parse(row.updatedAt) || 0);
        time.dataset.time = String(timestamp);
        time.dataset.kind = row.activityAt ? "活动" : "GitHub";
        time.title = timestamp ? new Date(timestamp).toLocaleString() : "尚无活动时间";
        time.textContent = `${time.dataset.kind} · ${ageLabel(timestamp, now)}`;
      }
      if (list.children[index] !== element) list.insertBefore(element, list.children[index] ?? null);
    }
    section.querySelector<HTMLElement>(".column-empty")!.hidden = selectedRows.length > 0;
    const more = section.querySelector<HTMLButtonElement>("[data-load-more]")!;
    more.hidden = selectedRows.length <= maximumPerColumn;
    more.textContent = `再显示 ${Math.min(40, selectedRows.length - maximumPerColumn)} 个（已显示 ${Math.min(maximumPerColumn, selectedRows.length)}/${selectedRows.length}）`;
  }
  for (const [key, element] of elements) if (!visible.has(key)) { movement.get(element)?.cancel(); movement.delete(element); element.remove(); elements.delete(key); bodies.delete(key); }
  const empty = select("#board-empty");
  empty.hidden = rows.length > 0;
  columns.hidden = rows.length === 0;
  const warning = transportError || store.error || trackingWarning;
  const offline = Boolean(transportError) || store.connection === "offline" && Boolean(store.at || store.lastSuccessAt || store.error);
  const uncertain = !store.complete || store.connection !== "live" || Boolean(warning);
  if (!rows.length) {
    const hasFilters = filters.repo !== "all" || Boolean(filters.query.trim()) || filters.filter !== "all";
    const title = store.rows.size ? "没有匹配的 PR" : offline ? "暂时无法读取 PR" : store.connection === "partial" || warning ? "尚无可确认的 PR" : !store.complete ? "正在同步你的 PR" : store.scope === "all" ? "当前没有 PR" : "当前没有进行中的 PR";
    const detail = store.rows.size ? `可以切换仓库、搜索条件或状态筛选。${uncertain ? "当前数据尚未完整确认，不能据此判断其他 PR 的状态。" : ""}`
      : warning || (offline ? "保留上次读取结果，等待重新核对 GitHub。" : !store.complete ? "正在分页读取当前 GitHub 账号，不限制仓库，也不只取前15条。" : store.scope === "all" ? "当前账号与本机关联范围内没有可显示的 PR。" : "可以切换显示范围，查看已合并和已关闭的 PR。");
    const action = hasFilters ? `<button type="button" class="text-link" data-clear-filters>查看所有 PR ${icon("arrow")}</button>`
      : offline || warning ? `<button type="button" class="text-link" data-retry-dashboard${refreshing ? " disabled" : ""}>重试读取 ${icon("arrow")}</button>` : "";
    empty.innerHTML = `<div>${icon(offline || warning ? "alert" : "board")}<h2>${escapeHtml(title)}</h2><p>${escapeHtml(detail)}</p>${action}</div>`;
  }
  const banner = select("#board-warning");
  banner.hidden = !warning;
  banner.textContent = warning;
  const waitingForQuota = store.retryAt && store.retryAt > now;
  const connection = waitingForQuota ? "等待 API 配额恢复" : offline ? "等待重新连接" : store.connection === "partial" ? "部分状态待确认" : refreshing || !store.complete ? "正在同步" : "持续同步中";
  select("#sync-state span").textContent = connection;
  select("#sync-state").classList.toggle("is-error", Boolean(warning));
  select("#last-sync").textContent = store.lastSuccessAt ? `GitHub · ${ageLabel(store.lastSuccessAt, now)}` : "尚未读取 GitHub";
  select("#coverage-note").textContent = store.invalidFrame ? `保留 ${store.rows.size} 个 PR · 本轮数据不完整` : offline ? `${store.rows.size} 个缓存 PR · 等待重新核对`
    : store.complete ? `${store.rows.size} 个 PR · ${uncertain ? "部分状态待确认" : "每30秒刷新"}` : `已读取 ${store.rows.size}/${Math.max(store.total, store.rows.size)} · 分页未结束`;
  select("#board-owner").textContent = store.owner ? `@${store.owner} · 不限仓库` : "GitHub 账号待确认";
  select<HTMLButtonElement>("#board-refresh").disabled = refreshing;
  updateRepos();
  if (detailDialog.open) updateDetail();
  geometry();
  if (canAnimate()) for (const [key, element] of elements) {
    const previous = oldRects.get(key);
    if (!previous) continue;
    const current = element.getBoundingClientRect();
    const horizontal = previous.left - current.left;
    const vertical = previous.top - current.top;
    if (Math.abs(horizontal) + Math.abs(vertical) < 2) continue;
    movement.get(element)?.cancel();
    if (typeof element.animate === "function") movement.set(element, element.animate([{ transform: `translate(${horizontal}px,${vertical}px)` }, { transform: "translate(0,0)" }], { duration: 300, easing: "cubic-bezier(.23,1,.32,1)" }));
  }
}

function queueRender(): void {
  if (renderFrame === undefined) renderFrame = requestAnimationFrame(render);
}

root.addEventListener("animationend", (event) => {
  const element = event.target as HTMLElement;
  if (event.animationName === "card-in") element.classList.remove("new-card");
  if (event.animationName === "received") element.classList.remove("received");
});

async function wake(): Promise<void> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 3000);
  try { await fetch("/wake", { signal: controller.signal }); } catch {}
  finally { clearTimeout(timeout); }
}

function finishRequest(reqId: string): void {
  const request = pending.get(reqId);
  if (!request) return;
  clearTimeout(request.timeout);
  if (request.retry !== undefined) clearTimeout(request.retry);
  pending.delete(reqId);
  if (request.op === "dashboard") refreshing = false;
}

async function ask(op: string, extra: Record<string, unknown> = {}): Promise<void> {
  if (disposed) return;
  if (!channel) {
    transportError = "当前宿主不支持面板通信，请更新 Cindy 后重试。";
    if (op === "dashboard-detail" && detailDialog.open) select("#detail-policy").textContent = transportError;
    queueRender(); return;
  }
  if (op === "dashboard" && (refreshing || document.visibilityState === "hidden")) return;
  if (op === "dashboard") { refreshing = true; queueRender(); }
  const requestedDetail = detailContext;
  await wake();
  if (disposed || op === "dashboard-detail" && (!detailDialog.open || requestedDetail !== detailContext)) return;
  const reqId = `${panelId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const message = { reqId, panelId, op, scope: store.scope, ...extra };
  const timeout = window.setTimeout(() => {
    finishRequest(reqId);
    if (op === "dashboard") {
      transportError = "宿主未在时限内返回，保留上次数据；稍后自动重试。";
      schedule(BOARD_REFRESH_MS);
    } else if (op === "dashboard-detail" && reqId === detailRequestId && detailDialog.open) {
      select("#detail-policy").textContent = "宿主未在时限内返回门禁信息；请重新打开详情重试。";
    }
    queueRender();
  }, 35_000);
  pending.set(reqId, { timeout, op });
  if (op === "dashboard-detail") detailRequestId = reqId;
  channel.postMessage(message);
  let retries = 0;
  const resend = () => {
    const request = pending.get(reqId);
    if (!request || request.retry === undefined || retries++ >= 3) return;
    channel.postMessage(message);
    request.retry = window.setTimeout(resend, 1000);
  };
  pending.get(reqId)!.retry = window.setTimeout(resend, 1000);
}

function schedule(delay: number): void {
  if (refreshTimer !== undefined) clearTimeout(refreshTimer);
  if (disposed || document.visibilityState === "hidden") return;
  refreshTimer = window.setTimeout(() => { refreshTimer = undefined; void ask("dashboard"); }, Math.max(650, delay));
}

function closeRepoMenu(restoreFocus = false): void {
  repoList.hidden = true;
  repoTrigger.setAttribute("aria-expanded", "false");
  if (restoreFocus) repoTrigger.focus();
}

function updateDetail(): void {
  const row = selectedKey ? store.rows.get(selectedKey) : undefined;
  if (!row) { detailDialog.close(); return; }
  const { status, detail } = cardState(row, Date.now());
  select("#detail-title").textContent = `${row.repo} #${row.number}`;
  const session = typeof row.sessionId === "string" && /^[A-Za-z0-9:_-]{8,160}$/.test(row.sessionId) ? `<a class="detail-link" href="cindy://sessions/${encodeURIComponent(row.sessionId)}">打开关联会话</a>` : "";
  const freshness = transportError || store.connection === "offline" ? "以下为已读取的数据，尚未重新确认 GitHub 当前状态。" : store.connection === "partial" || !store.complete ? "部分状态尚未完成核对；请结合读取提示判断。" : "";
  select("#detail-summary").innerHTML = `${freshness ? `<p role="status">${freshness}</p>` : ""}<p>${escapeHtml(row.title)}</p><dl><dt>当前状态</dt><dd>${escapeHtml(status)}</dd><dt>来源</dt><dd>${row.vigil ? "GitHub + Vigil 修复任务记录" : row.linked ? "GitHub + 本机 Keel 关联记录" : "GitHub（本机尚无 Keel 流程记录）"}</dd><dt>当前提交</dt><dd><code>${escapeHtml(row.headSha || "待确认")}</code></dd><dt>流程说明</dt><dd>${escapeHtml(detail)}</dd></dl><a class="detail-link" href="${pullUrl(row.repo, row.number)}" target="_blank" rel="noopener noreferrer">在 GitHub 查看 PR ${icon("arrow")}</a>${session}${vigilDetails(row)}`;
  const nextContext = JSON.stringify([store.owner, store.scope, row.key, row.headSha, row.state]);
  if (detailContext !== nextContext) {
    detailContext = nextContext;
    detailRequestId = undefined;
    const ended = row.state === "MERGED" || row.state === "CLOSED";
    select("#detail-policy").textContent = ended ? "这是已结束 PR 的历史记录，不再推进就绪与交接门禁。" : "正在核对该仓就绪与交接门禁…";
    if (!ended) void ask("dashboard-detail", { key: row.key });
  }
}

function openDetail(key: string, element?: HTMLElement): void {
  if (!store.rows.has(key)) return;
  selectedKey = key;
  detailContext = "";
  returnFocus = element ?? document.activeElement as HTMLElement;
  select("#detail-body").innerHTML = '<div id="detail-summary"></div><p id="detail-policy" role="status"></p>';
  if (!detailDialog.open) detailDialog.showModal();
  updateDetail();
}

channel?.addEventListener("message", ({ data }) => {
  if (!data || typeof data !== "object" || data.target && data.target !== panelId) return;
  if (data.type === "ack" && typeof data.reqId === "string") {
    const request = pending.get(data.reqId);
    if (request?.retry !== undefined) { clearTimeout(request.retry); request.retry = undefined; }
    return;
  }
  if (data.type === "dashboard-response" && data.target === panelId) {
    finishRequest(data.reqId);
    if (data.scope !== store.scope) return;
    transportError = "";
    schedule(data.retryAt && data.retryAt > Date.now() ? data.retryAt - Date.now() : data.complete || store.connection === "offline" ? BOARD_REFRESH_MS : 650);
    queueRender();
    return;
  }
  if (data.type === "dashboard-done" && data.target === panelId) { finishRequest(data.reqId); return; }
  if (data.type === "dashboard-error" && data.target === panelId) {
    const request = pending.get(data.reqId);
    if (!request) return;
    finishRequest(data.reqId);
    if (request?.op === "dashboard-detail") { const element = root.querySelector("#detail-policy"); if (element && data.reqId === detailRequestId && detailDialog.open) element.textContent = String(data.message ?? "门禁信息暂不可读"); }
    else { transportError = String(data.message ?? "读取失败"); schedule(BOARD_REFRESH_MS); queueRender(); }
    return;
  }
  if (data.type === "dashboard-warning") { trackingWarning = String(data.message ?? "部分关联记录不可读"); queueRender(); return; }
  if (data.type === "dashboard-invalidated" && typeof data.key === "string" && document.visibilityState !== "hidden") { void ask("dashboard-local", { key: data.key }); return; }
  if (data.type === "dashboard-detail") {
    finishRequest(data.reqId);
    if (data.key !== selectedKey || !detailDialog.open || data.reqId !== detailRequestId) return;
    const detail = data.detail;
    const element = root.querySelector("#detail-policy");
    if (element) element.textContent = detail && typeof detail === "object" ? String(detail.merge_hint ?? detail.rendered ?? "门禁信息已返回，请以 GitHub 当前提交为准。") : "门禁信息暂不可读。";
    return;
  }
  if (applyDashboardMessage(store, data, panelId)) { queueRender(); }
});

root.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const filter = target.closest<HTMLButtonElement>("[data-filter]");
  if (filter) { filters.filter = filter.dataset.filter as DashboardFilters["filter"]; maximumPerColumn = 40; queueRender(); return; }
  const stage = target.closest<HTMLButtonElement>("[data-flow-node]");
  if (stage) { const next = stage.dataset.flowNode as BoardStage; focusedStage = focusedStage === next ? null : next; queueRender(); return; }
  const repo = target.closest<HTMLButtonElement>("[data-repo]");
  if (repo) { filters.repo = repo.dataset.repo!; maximumPerColumn = 40; closeRepoMenu(true); queueRender(); return; }
  if (target.closest("#repo-filter")) {
    if (!repoList.hidden) closeRepoMenu();
    else { updateRepos(); repoList.hidden = false; repoTrigger.setAttribute("aria-expanded", "true"); repoList.querySelector<HTMLElement>('[aria-checked="true"]')?.focus(); }
    return;
  }
  if (target.closest("[data-load-more]")) { maximumPerColumn += 40; queueRender(); return; }
  if (target.closest(".search-clear")) { search.value = ""; filters.query = ""; search.closest(".search")?.classList.remove("has-value"); search.focus(); queueRender(); return; }
  if (target.closest("[data-clear-filters]")) { filters = { repo: "all", query: "", filter: "all", stage: null }; focusedStage = null; search.value = ""; search.closest(".search")?.classList.remove("has-value"); maximumPerColumn = 40; queueRender(); return; }
  if (target.closest("#board-refresh") || target.closest("[data-retry-dashboard]")) { transportError = ""; void ask("dashboard", { force: true }); return; }
  if (target.closest("[data-close-detail]")) { detailDialog.close(); return; }
  if (target.closest("a")) return;
  const card = target.closest<HTMLElement>(".pr-card[data-key]");
  if (card) openDetail(card.dataset.key!, card.querySelector<HTMLElement>("[data-action=detail]") ?? card);
});

search.addEventListener("input", () => { filters.query = search.value; maximumPerColumn = 40; search.closest(".search")?.classList.toggle("has-value", Boolean(search.value)); queueRender(); });
select<HTMLSelectElement>("#scope-filter").addEventListener("change", (event) => {
  for (const key of [...pending.keys()]) finishRequest(key);
  store = emptyDashboard((event.target as HTMLSelectElement).value === "all" ? "all" : "open");
  filters.repo = "all"; maximumPerColumn = 40; transportError = ""; trackingWarning = "";
  if (detailDialog.open) detailDialog.close();
  void ask("dashboard-restore").then(() => ask("dashboard", { force: true }));
  queueRender();
});
document.addEventListener("click", (event) => { if (!(event.target as HTMLElement).closest(".repo-menu")) closeRepoMenu(); });
repoList.addEventListener("keydown", (event) => {
  const options = Array.from(repoList.querySelectorAll<HTMLButtonElement>("[data-repo]"));
  const index = options.indexOf(document.activeElement as HTMLButtonElement);
  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    options[next]?.focus();
  }
});
document.addEventListener("keydown", (event) => { if (event.key === "Escape") { closeRepoMenu(true); focusedStage = null; queueRender(); } });
detailDialog.addEventListener("close", () => { selectedKey = null; detailContext = ""; detailRequestId = undefined; if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); });
viewport.addEventListener("scroll", () => { header.scrollLeft = viewport.scrollLeft; }, { passive: true });
const resize = new ResizeObserver(geometry);
resize.observe(viewport);
motion.addEventListener("change", () => { for (const animation of movement.values()) animation.cancel(); queueRender(); });
document.addEventListener("visibilitychange", () => {
  board.classList.toggle("offline-mode", document.visibilityState === "hidden" || !canAnimate());
  if (document.visibilityState === "hidden") { if (refreshTimer !== undefined) clearTimeout(refreshTimer); for (const animation of movement.values()) animation.cancel(); }
  else void ask("dashboard", { force: true });
  queueRender();
});
window.addEventListener("focus", () => { if (document.visibilityState !== "hidden") void ask("dashboard", { force: true }); });
const ageTimer = window.setInterval(queueRender, 15_000);
window.addEventListener("pagehide", () => {
  disposed = true;
  if (refreshTimer !== undefined) clearTimeout(refreshTimer);
  if (renderFrame !== undefined) cancelAnimationFrame(renderFrame);
  clearInterval(ageTimer);
  for (const reqId of [...pending.keys()]) finishRequest(reqId);
  for (const animation of movement.values()) animation.cancel();
  resize.disconnect(); channel?.close();
});
queueRender();
void ask("dashboard-restore").then(() => ask("dashboard"));
