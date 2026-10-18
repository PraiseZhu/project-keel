import { ACTIVITY_FRESH_MS, pullKey, validPullRef, withNewestActivity, type BoardActivity, type BoardCard, type BoardScope, type BoardStage } from "../shared/dashboard.ts";

export interface DashboardStore {
  scope: BoardScope;
  owner: string;
  epoch: string;
  retiredEpochs: Set<string>;
  generation: number;
  rows: Map<string, BoardCard>;
  seen: Set<string>;
  total: number;
  complete: boolean;
  invalidFrame: boolean;
  connection: "live" | "partial" | "offline";
  at: number;
  lastSuccessAt: number;
  error?: string;
  retryAt?: number;
}

export function emptyDashboard(scope: BoardScope = "open"): DashboardStore {
  return { scope, owner: "", epoch: "", retiredEpochs: new Set(), generation: -1, rows: new Map(), seen: new Set(), total: 0, complete: false, invalidFrame: false, connection: "offline", at: 0, lastSuccessAt: 0 };
}

export function validCard(value: unknown): value is BoardCard {
  if (!value || typeof value !== "object") return false;
  const row = value as BoardCard;
  const ciValid = !row.ci || typeof row.ci === "object" && [row.ci.passed, row.ci.failed, row.ci.pending, row.ci.total].every((count) => Number.isInteger(count) && count >= 0 && count <= 1_000_000)
    && row.ci.passed + row.ci.failed + row.ci.pending <= row.ci.total && typeof row.ci.complete === "boolean";
  return validPullRef(row.repo, row.number) && row.key === pullKey(row.repo, row.number)
    && typeof row.title === "string" && typeof row.sessionLabel === "string" && typeof row.detail === "string" && typeof row.status === "string"
    && typeof row.headSha === "string" && typeof row.updatedAt === "string" && ciValid
    && ["local", "cloud", "handoff"].includes(row.stage)
    && ["running", "waiting", "needs-human", "ready", "handed-off", "paused", "done", "unknown", "stale", "closed"].includes(row.activity)
    && ["OPEN", "CLOSED", "MERGED", "UNKNOWN"].includes(row.state)
    && !!row.step && Array.isArray(row.step.labels) && row.step.labels.length > 0 && row.step.labels.length <= 20
    && row.step.labels.every((label) => typeof label === "string")
    && (row.step.index === null || Number.isInteger(row.step.index) && row.step.index >= 0 && row.step.index < row.step.labels.length);
}

export function applyDashboardMessage(store: DashboardStore, raw: unknown, panelId: string): boolean {
  if (!raw || typeof raw !== "object") return false;
  const message = raw as Record<string, unknown>;
  if (message.target && message.target !== panelId || message.scope !== store.scope) return false;
  if (typeof message.epoch !== "string" || typeof message.generation !== "number" || !Number.isFinite(message.generation)) return false;
  if (store.retiredEpochs.has(message.epoch)) return false;
  if (message.type === "dashboard-begin") {
    if (typeof message.owner !== "string") return false;
    if (message.epoch === store.epoch && message.generation < store.generation) return false;
    if (message.epoch !== store.epoch) {
      if (store.epoch) store.retiredEpochs.add(store.epoch);
      store.epoch = message.epoch;
    }
    if (!message.keepExisting || store.owner !== message.owner) store.rows.clear();
    store.owner = message.owner;
    store.generation = message.generation;
    store.seen.clear();
    store.complete = false;
    store.invalidFrame = false;
    return true;
  }
  if (message.epoch !== store.epoch || message.generation !== store.generation || message.owner !== store.owner) return false;
  if (message.type === "dashboard-page") {
    if (!Array.isArray(message.rows) || !message.rows.every(validCard)) { store.invalidFrame = true; return false; }
    for (const row of message.rows) {
      store.rows.set(row.key, withNewestActivity(store.rows.get(row.key), row));
      store.seen.add(row.key);
    }
    return true;
  }
  if (message.type === "dashboard-local") {
    if (!validCard(message.row) || !store.rows.has(message.row.key)) return false;
    store.rows.set(message.row.key, withNewestActivity(store.rows.get(message.row.key), message.row));
    return true;
  }
  if (message.type === "dashboard-end") {
    store.complete = message.complete === true && !store.invalidFrame;
    store.connection = store.invalidFrame ? "offline" : message.connection === "live" || message.connection === "partial" ? message.connection : "offline";
    if (store.complete) for (const key of store.rows.keys()) if (!store.seen.has(key)) store.rows.delete(key);
    store.total = typeof message.total === "number" ? Math.max(message.total, store.rows.size) : store.rows.size;
    store.at = typeof message.at === "number" ? message.at : store.at;
    store.lastSuccessAt = typeof message.lastSuccessAt === "number" ? message.lastSuccessAt : store.lastSuccessAt;
    store.error = store.invalidFrame ? "看板收到不完整数据，保留已显示的卡片；请重试或重新打开面板。" : typeof message.error === "string" ? message.error : undefined;
    store.retryAt = typeof message.retryAt === "number" ? message.retryAt : undefined;
    return true;
  }
  return false;
}

export function activityOf(row: BoardCard, now: number): BoardActivity {
  return row.activity === "running" && (!row.activityAt || row.activityAt > now || now - row.activityAt > ACTIVITY_FRESH_MS) ? "stale" : row.activity;
}

export interface DashboardFilters {
  repo: string;
  query: string;
  filter: "all" | "running" | "attention";
  stage: BoardStage | null;
}

export function filteredCards(store: DashboardStore, filters: DashboardFilters, now: number): BoardCard[] {
  const query = filters.query.trim().toLowerCase();
  return [...store.rows.values()].filter((row) => {
    if (filters.repo !== "all" && row.repo.toLowerCase() !== filters.repo.toLowerCase()) return false;
    if (filters.stage && row.stage !== filters.stage) return false;
    if (query && !`${row.repo} #${row.number} ${row.title} ${row.sessionLabel}`.toLowerCase().includes(query)) return false;
    const activity = activityOf(row, now);
    if (filters.filter === "attention" && activity !== "needs-human") return false;
    if (filters.filter === "running" && (!row.runId || !["running", "waiting"].includes(activity))) return false;
    return true;
  }).sort((left, right) => {
    const urgency = (row: BoardCard) => activityOf(row, now) === "needs-human" ? 3 : row.state === "OPEN" ? 2 : 1;
    return urgency(right) - urgency(left) || (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0) || left.key.localeCompare(right.key);
  });
}

export function ageLabel(timestamp: number | undefined, now: number): string {
  if (!timestamp || !Number.isFinite(timestamp)) return "待确认";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 5) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}
