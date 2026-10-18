import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { ACTIVITY_FRESH_MS, BOARD_COLUMNS, BOARD_REFRESH_MS, pullUrl, type BoardActivity, type BoardCard } from "../../src/shared/dashboard.ts";
import { activityOf, ageLabel, applyDashboardMessage, cardState, emptyDashboard, filteredCards, validCard } from "../../src/panel/dashboard-model.ts";
import { cardBody, dashboardMarkup, escapeHtml, icon } from "../../src/panel/dashboard-render.ts";
import { makePull } from "./fixtures.ts";

const now = 1_800_000_000_000;
const card = (number = 1, overrides: Partial<BoardCard> = {}): BoardCard => ({
  ...makePull(number, { updatedAt: new Date(now - 1000).toISOString() }), stage: "cloud", activity: "unknown", status: "流程待确认",
  detail: "GitHub 已读取，本机尚无流程记录。", linked: false, sessionLabel: `任务 ${number}`, step: { index: null, labels: ["检查", "确认", "交接"], linear: false }, ...overrides,
});

class ElementHarness {
  hidden = false;
  open = false;
  disabled = false;
  innerHTML = "";
  textContent = "";
  title = "";
  className = "";
  scrollLeft = 0;
  scrollWidth = 0;
  offsetLeft = 0;
  offsetWidth = 80;
  width = 272;
  display = "grid";
  flexDirection = "row";
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  nodes = new Map<string, ElementHarness>();
  children: ElementHarness[] = [];
  parentElement: ElementHarness | null = null;
  events = new Map<string, (...args: unknown[]) => void>();
  classes = new Set<string>();
  classList = {
    add: (...values: string[]) => values.forEach((value) => this.classes.add(value)),
    remove: (...values: string[]) => values.forEach((value) => this.classes.delete(value)),
    toggle: (value: string, enabled = !this.classes.has(value)) => enabled ? this.classes.add(value) : this.classes.delete(value),
  };
  style = {
    width: "", gridTemplateColumns: "", gap: "", properties: new Map<string, string>(),
    setProperty: (key: string, value: string) => this.style.properties.set(key, value),
    removeProperty: (key: string) => {
      if (key === "width") this.style.width = "";
      if (key === "grid-template-columns") this.style.gridTemplateColumns = "";
      this.style.properties.delete(key);
    },
  };
  get isConnected(): boolean { return this.parentElement !== null; }
  querySelector(selector: string): ElementHarness | null {
    if (selector === ".filter-tab.selected") return this.children.find((child) => child.classes.has("selected")) ?? null;
    const column = selector.match(/^\[data-(column|header-column)="([^"]+)"\]$/);
    if (column) return this.children.find((child) => child.dataset[column[1] === "column" ? "column" : "headerColumn"] === column[2]) ?? null;
    return this.nodes.get(selector) ?? null;
  }
  querySelectorAll(selector: string): ElementHarness[] {
    if (selector === ".column") return this.children;
    if (selector === "[data-filter]") return this.nodes.get(".filter-tabs")?.children ?? [];
    return [];
  }
  append(child: ElementHarness): void { this.insertBefore(child, null); }
  insertBefore(child: ElementHarness, reference: ElementHarness | null): void {
    child.remove();
    const index = reference ? this.children.indexOf(reference) : this.children.length;
    this.children.splice(index, 0, child);
    child.parentElement = this;
  }
  remove(): void {
    if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
  getBoundingClientRect(): { width: number; left: number; top: number } {
    let element: ElementHarness | null = this;
    while (element) { if (element.hidden) return { width: 0, left: 0, top: 0 }; element = element.parentElement; }
    return { width: this.width, left: 0, top: 0 };
  }
  setAttribute(key: string, value: string): void { this.attributes.set(key, value); }
  contains(element: ElementHarness | null): boolean { return this === element || this.children.some((child) => child.contains(element)); }
  focus(): void {}
  addEventListener(name: string, callback: (...args: unknown[]) => void): void { this.events.set(name, callback); }
  showModal(): void { this.open = true; }
  close(): void { this.open = false; this.events.get("close")?.(); }
}

const source = ts.createSourceFile("panel.ts", readFileSync("src/panel/panel.ts", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const runtime = ts.transpileModule(source.statements.filter((statement) => ts.isFunctionDeclaration(statement)
  || statement.getText(source).startsWith('channel?.addEventListener("message"')
  || statement.getText(source).startsWith('detailDialog.addEventListener("close"'))
  .map((statement) => statement.getText(source)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

function panel(width = 334, rows: BoardCard[] = []) {
  const root = new ElementHarness();
  const select = (selector: string) => {
    let element = root.nodes.get(selector);
    if (!element) { element = new ElementHarness(); root.nodes.set(selector, element); }
    return element;
  };
  const columns = select(".columns");
  const headerTrack = select(".board-header-track");
  for (const column of BOARD_COLUMNS) {
    for (const [container, attribute] of [[columns, "column"], [headerTrack, "headerColumn"]] as const) {
      const section = new ElementHarness(); section.dataset[attribute] = column.id;
      for (const selector of [".column-count", "[data-flow-node]", ".column-cards", ".column-empty", "[data-load-more]"]) section.nodes.set(selector, new ElementHarness());
      container.append(section);
    }
  }
  for (const filter of ["all", "running", "attention"]) {
    const button = new ElementHarness(); button.dataset.filter = filter;
    button.nodes.set(".count", new ElementHarness()); select(".filter-tabs").append(button);
  }
  select("#repo-filter").nodes.set(".repo-trigger-label", new ElementHarness());
  select("#repo-list").hidden = true;
  const store = emptyDashboard();
  Object.assign(store, { owner: "demo", epoch: "brain-1", generation: 1, complete: true, connection: "live", at: now, lastSuccessAt: now, total: rows.length });
  for (const row of rows) store.rows.set(row.key, row);
  let clock = now;
  let timerId = 0;
  let receive: (event: { data: Record<string, unknown> }) => void;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const outbound: Record<string, unknown>[] = [];
  const elements = new Map<string, ElementHarness>();
  const sandbox = {
    root, select, store, elements, filters: { repo: "all", query: "", filter: "all", stage: null }, board: select(".kb"),
    viewport: select(".board-scroll"), header: select(".board-header-viewport"), headerTrack, columns,
    repoList: select("#repo-list"), repoTrigger: select("#repo-filter"), detailDialog: select("#pr-detail"), motion: { matches: false },
    focusedStage: null, maximumPerColumn: 40, refreshing: false, refreshTimer: undefined, renderFrame: undefined, transportError: "", trackingWarning: "",
    selectedKey: null, detailContext: "", detailRequestId: undefined, returnFocus: null, disposed: false, panelId: "panel",
    bodies: new Map(), movement: new Map(), pending: new Map(), numbers: new Map(),
    BOARD_COLUMNS, BOARD_REFRESH_MS, pullUrl, activityOf, ageLabel, applyDashboardMessage, cardState, emptyDashboard, filteredCards, cardBody, escapeHtml, icon,
    document: {
      visibilityState: "visible", activeElement: null,
      createElement: () => { const element = new ElementHarness(); element.nodes.set("time[data-time]", new ElementHarness()); return element; },
    },
    getComputedStyle: (element: ElementHarness) => ({ display: element.hidden ? "none" : element.display, flexDirection: element.flexDirection, columnGap: "16px" }),
    requestAnimationFrame: () => ++timerId,
    Date: class extends Date { static now() { return clock; } }, AbortController,
    fetch: async () => ({ ok: true }),
    setTimeout: (callback: () => void, delay: number) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
    channel: { postMessage: (message: Record<string, unknown>) => outbound.push(message), addEventListener: (_name: string, callback: typeof receive) => { receive = callback; } },
  };
  const context = createContext({ ...sandbox, window: sandbox });
  runInContext(runtime, context);
  const resize = (nextWidth: number) => {
    columns.display = nextWidth <= 640 ? "flex" : "grid";
    columns.flexDirection = nextWidth <= 640 ? "column" : "row";
    for (const section of columns.children) section.width = nextWidth <= 640 ? nextWidth - 34 : nextWidth <= 1150 ? 272 : (nextWidth - 80) / 3;
    columns.scrollWidth = nextWidth <= 640 ? nextWidth - 34 : columns.children[0]!.width * 3 + 32;
  };
  resize(width);
  return {
    context, store, elements, select, columns, header: sandbox.header, headerTrack, filters: sandbox.filters, outbound, resize,
    render: () => runInContext("render()", context),
    geometry: () => runInContext("geometry()", context),
    time: (value: number) => { clock = value; },
    openDetail: (key: string) => { context.openKey = key; runInContext("openDetail(openKey)", context); },
    receive: (data: Record<string, unknown>) => receive({ data }),
    flush: async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); },
    timeout: (delay: number) => { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); } },
  };
}

describe("dashboard empty-state geometry", () => {
  it.each([334, 900, 1440])("restores valid columns after a zero-result filter at %ipx", (width) => {
    const view = panel(width, [card(1, { stage: "local" }), card(2)]);
    view.render();
    expect(view.columns.hidden).toBe(false);
    expect(view.header.hidden).toBe(width <= 640);
    const previousColumns = view.headerTrack.style.gridTemplateColumns;
    for (const filter of ["running", "attention"]) {
      view.filters.filter = filter; view.render();
      expect(view.columns.hidden).toBe(true);
      expect(view.header.hidden).toBe(true);
      expect(view.headerTrack.style.gridTemplateColumns).toBe("");
      expect(view.headerTrack.style.width).toBe("");
      expect(view.select("#board-empty").innerHTML).toContain("没有匹配的 PR");
      expect(view.select(".filter-tabs").children[0]!.querySelector(".count")!.textContent).toBe("2");
      view.filters.filter = "all"; view.render();
      expect(view.columns.hidden).toBe(false);
      expect(view.headerTrack.style.gridTemplateColumns).toBe(previousColumns);
    }
    view.filters.query = "nothing-matches"; view.render();
    expect(view.header.hidden).toBe(true);
    view.filters.query = ""; view.filters.repo = "missing/repo"; view.render();
    expect(view.header.hidden).toBe(true);
    view.filters.repo = "all"; view.render();
    expect(view.columns.hidden).toBe(false);
  });

  it("does not publish zero-width headers while a containing panel is unmeasurable", () => {
    const view = panel(900, [card()]);
    view.render();
    for (const section of view.columns.children) section.width = 0;
    view.geometry();
    expect(view.header.hidden).toBe(true);
    expect(view.headerTrack.style.gridTemplateColumns).toBe("");
    view.resize(900); view.geometry();
    expect(view.header.hidden).toBe(false);
    expect(view.headerTrack.style.gridTemplateColumns).toBe("272px 272px 272px");
    view.resize(334); view.geometry();
    expect(view.header.hidden).toBe(true);
    expect(view.headerTrack.style.gridTemplateColumns).toBe("");
  });

  it.each([
    { label: "loading", complete: false, connection: "offline", at: 0, lastSuccessAt: 0, title: "正在同步你的 PR", sync: "正在同步" },
    { label: "zero-open", complete: true, connection: "live", title: "当前没有进行中的 PR", sync: "持续同步中" },
    { label: "zero-history", complete: true, connection: "live", scope: "all", title: "当前没有 PR", sync: "持续同步中" },
    { label: "offline-cache", complete: true, connection: "offline", title: "暂时无法读取 PR", sync: "等待重新连接" },
    { label: "partial-scan", complete: false, connection: "partial", title: "尚无可确认的 PR", sync: "部分状态待确认" },
    { label: "partial-read", complete: true, connection: "partial", error: "部分关联不可读", title: "尚无可确认的 PR", sync: "部分状态待确认" },
  ])("hides both header surfaces for $label", (scenario) => {
    const view = panel(334);
    const { title, sync, label: _label, ...state } = scenario;
    Object.assign(view.store, state); view.render();
    expect(view.columns.hidden).toBe(true);
    expect(view.header.hidden).toBe(true);
    expect(view.select("#board-empty").hidden).toBe(false);
    expect(view.select("#board-empty").innerHTML).toContain(title);
    expect(view.select("#sync-state span").textContent).toBe(sync);
    expect(view.select("#board-empty").innerHTML).not.toContain("data-clear-filters");
  });

  it.each(["offline", "partial"] as const)("does not mistake an empty filter for a failed board in %s mode", (connection) => {
    const view = panel(900, [card()]);
    Object.assign(view.store, { connection, complete: false, error: "部分读取失败" });
    view.filters.filter = "running"; view.render();
    expect(view.select("#board-empty").innerHTML).toContain("没有匹配的 PR");
    expect(view.select("#board-empty").innerHTML).toContain("尚未完整确认");
    expect(view.header.hidden).toBe(true);
  });
});

describe("dashboard activity and detail presentation", () => {
  it.each(["running", "waiting", "needs-human", "ready", "handed-off", "paused", "done", "unknown", "stale", "closed"] as BoardActivity[])("renders %s without changing the stage or inventing human intervention", (activity) => {
    const row = card(1, { activity, status: activity === "waiting" ? "等待主控裁决" : `状态 ${activity}`, runId: "run", activityAt: now - 1000 });
    const view = panel(334, [row]); view.render();
    expect(view.columns.hidden).toBe(false);
    expect(view.elements.get(row.key)!.dataset.activity).toBe(activity);
    expect(view.elements.get(row.key)!.innerHTML).toContain(`data-activity-indicator="${activity}"`);
    expect(view.select(".filter-tabs").children[2]!.querySelector(".count")!.textContent).toBe(activity === "needs-human" ? "1" : "0");
    if (activity === "waiting") {
      expect(view.elements.get(row.key)!.innerHTML).toContain("等待主控裁决");
      expect(view.elements.get(row.key)!.innerHTML).not.toMatch(/等待外部结果|需要你介入/);
    }
  });

  it("uses the same stale status in the card, accessibility label and open details", async () => {
    const row = card(1, { activity: "running", status: "正在实现", runId: "run", activityAt: now - 1000 });
    const view = panel(334, [row]); view.render(); view.openDetail(row.key); await view.flush();
    expect(view.select("#detail-summary").innerHTML).toContain("正在实现");
    view.time(now + ACTIVITY_FRESH_MS); view.render();
    expect(view.select("#detail-summary").innerHTML).toContain("活动待确认");
    expect(view.select("#detail-summary").innerHTML).not.toContain("正在实现");
    expect(view.elements.get(row.key)!.attributes.get("aria-label")).toContain("活动待确认");
    expect(view.elements.get(row.key)!.innerHTML).toContain("步骤 ?");
    expect(view.outbound).toHaveLength(1);
  });

  it.each([
    { status: "状态暂不可读", detail: "GitHub 状态读取失败，保留上次记录。", error: "读取失败" },
    { status: "工作流记录待确认", detail: "本机工作流记录尚未完成核对。", error: undefined },
  ])("preserves the server's stale reason: $status", async ({ status, detail, error }) => {
    const row = card(1, { activity: "stale", status, detail, error, activityAt: now - ACTIVITY_FRESH_MS - 1 });
    expect(cardState(row, now)).toEqual({ activity: "stale", status, detail });
    const view = panel(334, [row]); view.render(); view.openDetail(row.key); await view.flush();
    expect(view.elements.get(row.key)!.innerHTML).toContain(`<span class="status-text" title="${status}">${status}</span>`);
    expect(view.elements.get(row.key)!.attributes.get("aria-label")).toContain(status);
    expect(view.select("#detail-summary").innerHTML).toContain(`<dd>${status}</dd>`);
    expect(view.select("#detail-summary").innerHTML).toContain(detail);
    expect(view.select("#detail-summary").innerHTML).not.toContain("活动待确认");
  });

  it("updates timestamp labels and tooltips without rebuilding unchanged card content", () => {
    const row = card(1, { activity: "running", status: "正在实现", runId: "run", activityAt: now - 2000 });
    const view = panel(334, [row]); view.render();
    const element = view.elements.get(row.key)!;
    const previousBody = element.innerHTML;
    view.store.rows.set(row.key, { ...row, activityAt: now - 500 }); view.render();
    expect(element.innerHTML).toBe(previousBody);
    expect(element.querySelector("time[data-time]")!.dataset.time).toBe(String(now - 500));
    expect(element.querySelector("time[data-time]")!.title).toBe(new Date(now - 500).toLocaleString());
  });

  it("rechecks changed HEAD details and rejects a late result for the old HEAD", async () => {
    const row = card(); const view = panel(334, [row]);
    view.render(); view.openDetail(row.key); await view.flush();
    const previous = view.outbound[0]!;
    view.store.rows.set(row.key, { ...row, headSha: "b".repeat(40) }); view.render(); await view.flush();
    const current = view.outbound[1]!;
    view.receive({ type: "dashboard-detail", reqId: previous.reqId, key: row.key, detail: { merge_hint: "旧提交可合并" } });
    expect(view.select("#detail-policy").textContent).not.toContain("旧提交");
    view.receive({ type: "dashboard-detail", reqId: current.reqId, key: row.key, detail: { merge_hint: "当前提交待核对" } });
    expect(view.select("#detail-policy").textContent).toBe("当前提交待核对");
    view.store.rows.clear(); view.render();
    expect(view.select("#pr-detail").open).toBe(false);
    expect(view.context.selectedKey).toBeNull();
  });

  it.each(["MERGED", "CLOSED"] as const)("shows %s as history without requesting active handoff gates", async (state) => {
    const row = card(1, { state, activity: "closed", status: state === "MERGED" ? "已合并" : "已关闭" });
    const view = panel(334, [row]); view.store.scope = "all";
    view.render(); view.openDetail(row.key); await view.flush();
    expect(view.select("#detail-policy").textContent).toContain("历史记录");
    expect(view.outbound).toHaveLength(0);
    expect(view.elements.get(row.key)!.innerHTML).toContain(row.status);
  });

  it("explains offline detail freshness and a timed-out gate request", async () => {
    const row = card(); const view = panel(334, [row]); view.store.connection = "offline";
    view.openDetail(row.key); await view.flush();
    expect(view.select("#detail-summary").innerHTML).toContain("尚未重新确认");
    view.timeout(35_000);
    expect(view.select("#detail-policy").textContent).toContain("未在时限内返回");
    view.receive({ type: "dashboard-error", target: "panel", reqId: view.outbound[0]!.reqId, message: "过期请求失败" });
    expect(view.context.transportError).toBe("");
  });
});

describe("dashboard full-frame integrity", () => {
  it("continues healthy pagination after a partial warning instead of delaying every page by 30 seconds", async () => {
    const view = panel(334, [card()]);
    Object.assign(view.store, { connection: "partial", complete: false, error: "某条交接记录无法读取" });
    view.receive({ type: "dashboard-response", target: "panel", reqId: "first-page", scope: "open", complete: false, error: view.store.error });
    view.timeout(650);
    await view.flush();
    expect(view.outbound).toHaveLength(1);
    expect(view.outbound[0]).toMatchObject({ op: "dashboard", scope: "open" });
  });

  it("still backs off on an offline response", async () => {
    const view = panel(334, [card()]);
    Object.assign(view.store, { connection: "offline", complete: false, error: "网络不可读" });
    view.receive({ type: "dashboard-response", target: "panel", reqId: "first-page", scope: "open", complete: false, error: view.store.error });
    view.timeout(650);
    await view.flush();
    expect(view.outbound).toEqual([]);
    view.timeout(30_000);
    await view.flush();
    expect(view.outbound).toHaveLength(1);
  });

  const packet = (type: string, extra: Record<string, unknown> = {}) => ({ type, scope: "open", owner: "demo", epoch: "brain-1", generation: 1, ...extra });
  function seeded() {
    const store = emptyDashboard();
    applyDashboardMessage(store, packet("dashboard-begin", { rowCount: 2, keepExisting: true }), "panel");
    applyDashboardMessage(store, packet("dashboard-page", { rows: [card(1), card(2)] }), "panel");
    applyDashboardMessage(store, packet("dashboard-end", { rowCount: 2, total: 2, complete: true, connection: "live", lastSuccessAt: now - 1000 }), "panel");
    return store;
  }

  it.each(["dropped", "duplicate"])("keeps old cards and freshness when a %s page prevents a full frame", (kind) => {
    const store = seeded();
    applyDashboardMessage(store, packet("dashboard-begin", { generation: 2, keepExisting: true, rowCount: 2 }), "panel");
    applyDashboardMessage(store, packet("dashboard-page", { generation: 2, rows: kind === "duplicate" ? [card(1), card(1)] : [card(1)] }), "panel");
    applyDashboardMessage(store, packet("dashboard-end", { generation: 2, rowCount: 2, total: 2, complete: true, connection: "live", lastSuccessAt: now }), "panel");
    expect(store.rows.size).toBe(2);
    expect(store).toMatchObject({ connection: "offline", complete: false, lastSuccessAt: now - 1000, invalidFrame: true });
    expect(store.error).toContain("不完整数据");
  });

  it("does not prune until an intact completed scan, including an empty frame", () => {
    const store = seeded();
    applyDashboardMessage(store, packet("dashboard-begin", { generation: 2, keepExisting: true, rowCount: 1 }), "panel");
    applyDashboardMessage(store, packet("dashboard-page", { generation: 2, rows: [card(1)] }), "panel");
    applyDashboardMessage(store, packet("dashboard-end", { generation: 2, rowCount: 1, total: 5, complete: false, connection: "partial" }), "panel");
    expect(store).toMatchObject({ complete: false, connection: "partial", invalidFrame: false });
    expect(store.rows.size).toBe(2);
    applyDashboardMessage(store, packet("dashboard-begin", { generation: 3, keepExisting: true, rowCount: 0 }), "panel");
    expect(store.rows.size).toBe(2);
    applyDashboardMessage(store, packet("dashboard-end", { generation: 3, rowCount: 0, total: 0, complete: true, connection: "live" }), "panel");
    expect(store.rows.size).toBe(0);
    expect(store).toMatchObject({ complete: true, connection: "live", invalidFrame: false });
  });

  it.each([-1, 1.5, NaN, null, "2"])("rejects invalid frame rowCount %s", (rowCount) => {
    const store = seeded();
    applyDashboardMessage(store, packet("dashboard-begin", { generation: 2, keepExisting: true, rowCount }), "panel");
    applyDashboardMessage(store, packet("dashboard-page", { generation: 2, rows: [card(1), card(2)] }), "panel");
    applyDashboardMessage(store, packet("dashboard-end", { generation: 2, rowCount, complete: true, connection: "live" }), "panel");
    expect(store).toMatchObject({ complete: false, connection: "offline", invalidFrame: true });
  });

  it("rejects inconsistent begin/end counts, even if the end matches seen keys", () => {
    const store = seeded();
    applyDashboardMessage(store, packet("dashboard-begin", { generation: 2, keepExisting: true, rowCount: 2 }), "panel");
    applyDashboardMessage(store, packet("dashboard-page", { generation: 2, rows: [card(1)] }), "panel");
    applyDashboardMessage(store, packet("dashboard-end", { generation: 2, rowCount: 1, complete: true, connection: "live" }), "panel");
    expect(store.complete).toBe(false); expect(store.rows.size).toBe(2);
  });

  it("clears another owner's data and freshness even when keepExisting is true", () => {
    const store = seeded();
    applyDashboardMessage(store, packet("dashboard-begin", { generation: 2, owner: "other", keepExisting: true, rowCount: 1 }), "panel");
    expect(store.rows.size).toBe(0);
    expect(store).toMatchObject({ lastSuccessAt: 0, total: 0, connection: "offline" });
  });

  it("accepts legacy frames without rowCount but does not claim a partial scan is live", () => {
    const store = emptyDashboard();
    applyDashboardMessage(store, packet("dashboard-begin"), "panel");
    applyDashboardMessage(store, packet("dashboard-page", { rows: [card()] }), "panel");
    applyDashboardMessage(store, packet("dashboard-end", { complete: false, connection: "live" }), "panel");
    expect(store).toMatchObject({ complete: false, connection: "partial", invalidFrame: false });
    applyDashboardMessage(store, packet("dashboard-end", { complete: true, connection: "live" }), "panel");
    expect(store).toMatchObject({ complete: true, connection: "live" });
  });

  it("accepts finite workflow ordering timestamps without treating them as activity evidence", () => {
    expect(validCard(card(1, { workflowAt: now }))).toBe(true);
    for (const workflowAt of [NaN, Infinity, "now", null]) expect(validCard({ ...card(), workflowAt })).toBe(false);
    expect(cardState(card(1, { workflowAt: now, activity: "running", activityAt: now - ACTIVITY_FRESH_MS - 1 }), now).activity).toBe("stale");
  });
});

describe("dashboard visual contract", () => {
  it("starts hidden, keeps the fixed card and step geometry, and retains reduced-motion safeguards", () => {
    const markup = dashboardMarkup();
    const css = readFileSync("plugin/panel.css", "utf8");
    expect(markup).toContain('class="board-header-viewport" aria-label="流程节点" hidden');
    expect(markup).toContain('class="columns" style="--column-count:3" hidden');
    expect(css).toContain("height:208px;min-height:208px;max-height:208px");
    expect(css).toMatch(/\.step-line\{[^}]*width:92px/);
    expect(css).toMatch(/\.sl\{[^}]*height:3px/);
    expect(css).toMatch(/\.step-no\{[^}]*width:44px/);
    expect(css).toContain("@container(max-width:640px)");
    expect(css).toContain(".columns{display:flex;flex-direction:column");
    expect(css).toContain("prefers-reduced-motion:reduce");
    expect(css).toContain(".kb.offline-mode *::before");
    expect(css).toContain("grid-template-columns:86px minmax(0,1fr)");
    expect(cardBody(card(), now)).not.toMatch(/step-dot|class="thumb"/);
  });
});
