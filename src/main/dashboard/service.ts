import { BOARD_REFRESH_MS, pullKey, pullUrl, validPullRef, withNewestActivity, type BoardScope, type BoardSnapshot, type BoardCard, type PullPage, type RemotePull, type ManagedPull } from "../../shared/dashboard.ts";
import { node, type ToolContext } from "../context.ts";
import { KeelError, type Host } from "../host.ts";
import { currentDashboardHandoff, prepareDashboardHandoffContext } from "./handoff.ts";
import { boardEvidence } from "./registry.ts";
import { projectPull } from "./project.ts";
import { loadVigilProgress, projectVigil, retainVigilOnError, vigilByPull } from "./vigil.ts";

async function dashboardEvidence(ctx: ToolContext) {
  const evidence = await boardEvidence(ctx.host);
  const snapshot = await loadVigilProgress(ctx);
  const vigil = vigilByPull(snapshot);
  for (const [key, row] of vigil) if (!evidence.refs.has(key))
    evidence.refs.set(key, { repo: row.repo, number: row.number, sessionId: row.sessionId, at: row.taskAt });
  return { ...evidence, vigil, warnings: snapshot.warnings };
}

interface Scan {
  generation: number;
  cycle: number;
  owner: string;
  rows: Map<string, BoardCard>;
  cursor?: string;
  cursors: Set<string>;
  total: number;
  remoteDone: boolean;
  linked?: ManagedPull[];
  linkedOffset: number;
  collecting: boolean;
  lastAttempt: number;
  snapshot?: BoardSnapshot;
  previous?: BoardSnapshot;
  retryAt?: number;
  inFlight?: Promise<BoardSnapshot>;
  localVersions: Map<string, number>;
  warnings: Set<string>;
}

const hosts = new WeakMap<Host, Map<BoardScope, Scan>>();
const epoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function scanFor(host: Host, scope: BoardScope): Scan {
  let scopes = hosts.get(host);
  if (!scopes) { scopes = new Map(); hosts.set(host, scopes); }
  let scan = scopes.get(scope);
  if (!scan) {
    scan = { generation: 0, cycle: 0, owner: "", rows: new Map(), cursors: new Set(), total: 0, remoteDone: false, linkedOffset: 0, collecting: false, lastAttempt: 0, localVersions: new Map(), warnings: new Set() };
    scopes.set(scope, scan);
  }
  return scan;
}

function meta(snapshot: BoardSnapshot, generation: number) {
  const { rows: _rows, ...rest } = snapshot;
  return { ...rest, generation, epoch, rowCount: snapshot.rows.length };
}

function sendRows(host: Host, scope: BoardScope, generation: number, owner: string, rows: BoardCard[], target?: string): void {
  let batch: BoardCard[] = [];
  let bytes = 0;
  const flush = () => {
    if (batch.length) host.broadcast({ type: "dashboard-page", generation, epoch, scope, owner, rows: batch, ...(target ? { target } : {}) });
    batch = []; bytes = 0;
  };
  for (const row of rows) {
    const size = new TextEncoder().encode(JSON.stringify(row)).length;
    if (bytes + size > 30_000 || batch.length >= 20) flush();
    batch.push(row); bytes += size;
  }
  flush();
}

export function sendDashboard(host: Host, snapshot: BoardSnapshot, generation: number, target?: string): void {
  host.broadcast({ type: "dashboard-begin", ...meta(snapshot, generation), keepExisting: true, ...(target ? { target } : {}) });
  sendRows(host, snapshot.scope, generation, snapshot.owner, snapshot.rows, target);
  host.broadcast({ type: "dashboard-end", ...meta(snapshot, generation), ...(target ? { target } : {}) });
}

function publishDashboard(host: Host, scan: Scan, snapshot: BoardSnapshot): BoardSnapshot {
  scan.generation += 1;
  sendDashboard(host, snapshot, scan.generation);
  return snapshot;
}

function validCache(value: unknown, scope: BoardScope): value is BoardSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as BoardSnapshot;
  return snapshot.version === 1 && snapshot.scope === scope && typeof snapshot.owner === "string" && typeof snapshot.at === "number"
    && Array.isArray(snapshot.rows) && snapshot.rows.every((row) => row && validPullRef(row.repo, row.number) && row.key === pullKey(row.repo, row.number)
      && ["local", "cloud", "handoff"].includes(row.stage) && row.step && Array.isArray(row.step.labels));
}

export async function restoreDashboard(ctx: ToolContext, scope: BoardScope, target: string): Promise<void> {
  const scan = scanFor(ctx.host, scope);
  const cycle = scan.cycle;
  if (!scan.snapshot && !scan.inFlight && !scan.collecting) {
    const file = await ctx.host.fs({ op: "read", root: "data", path: `board/dashboard-${scope}.json` });
    if (!scan.snapshot && !scan.inFlight && !scan.collecting && scan.cycle === cycle && file.ok && file.content) {
      try {
        const saved: unknown = JSON.parse(file.content);
        if (validCache(saved, scope)) {
          scan.snapshot = { ...saved, connection: "offline", error: "这是上次同步的缓存，正在重新核对 GitHub。" };
          scan.previous = scan.snapshot;
          scan.owner = saved.owner;
        }
      } catch { scan.snapshot = undefined; }
    }
  }
  if (scan.snapshot && (!scan.owner || scan.snapshot.owner === scan.owner)) sendDashboard(ctx.host, scan.snapshot, scan.generation, target);
}

function placeholder(ref: ManagedPull, previous?: BoardCard): RemotePull {
  return previous ?? {
    key: pullKey(ref.repo, ref.number), repo: ref.repo, number: ref.number, url: pullUrl(ref.repo, ref.number), title: `${ref.repo} #${ref.number}`,
    author: "", state: "UNKNOWN", isDraft: false, updatedAt: "", headSha: "", checks: "UNKNOWN", review: "UNKNOWN", mergeable: "UNKNOWN", mergeState: "UNKNOWN",
  };
}

function missingReferences(scan: Scan, refs: Map<string, ManagedPull>): ManagedPull[] {
  const known = new Map(refs);
  if (scan.previous?.owner === scan.owner) for (const row of scan.previous.rows) {
    if (!known.has(row.key)) known.set(row.key, { repo: row.repo, number: row.number, at: scan.previous.at });
  }
  return [...known.values()].filter((ref) => !scan.rows.has(pullKey(ref.repo, ref.number)));
}

export async function refreshDashboard(ctx: ToolContext, options: { scope?: BoardScope; force?: boolean } = {}): Promise<BoardSnapshot> {
  const scope = options.scope === "all" ? "all" : "open";
  const scan = scanFor(ctx.host, scope);
  if (scan.inFlight) return scan.inFlight;
  const now = ctx.host.now();
  if (scan.snapshot && ((scan.retryAt && now < scan.retryAt) || (!scan.collecting && !options.force && now - scan.lastAttempt < BOARD_REFRESH_MS))) return publishDashboard(ctx.host, scan, scan.snapshot);
  if (scan.snapshot && now - scan.lastAttempt < 500) return publishDashboard(ctx.host, scan, scan.snapshot);
  scan.lastAttempt = now;
  if (!scan.collecting) {
    scan.cycle += 1;
    scan.previous = scan.snapshot;
    scan.rows = new Map();
    scan.cursors = new Set();
    scan.cursor = undefined;
    scan.remoteDone = false;
    scan.linked = undefined;
    scan.linkedOffset = 0;
    scan.total = 0;
    scan.collecting = true;
    scan.retryAt = undefined;
    scan.warnings.clear();
    scan.localVersions.clear();
  }
  const work = async (): Promise<BoardSnapshot> => {
    try {
      const evidence = await dashboardEvidence(ctx);
      for (const warning of evidence.warnings) scan.warnings.add(warning);
      const handoffContext = await prepareDashboardHandoffContext(ctx);
      const add = async (pull: RemotePull, error?: string): Promise<void> => {
        let handoff = null;
        let handoffError: string | undefined;
        try { handoff = await currentDashboardHandoff(handoffContext, pull); } catch {
          handoffError = "当前交接状态无法核实，不能确认 mini 是否接手。";
          scan.warnings.add("部分交接状态无法核实，未推断 mini 的进展。");
        }
        const prior = scan.rows.get(pull.key) ?? (scan.snapshot?.owner === scan.owner ? scan.snapshot.rows.find((row) => row.key === pull.key) : undefined);
        const projected = retainVigilOnError(projectVigil(projectPull(pull, { now: ctx.host.now(), ref: evidence.refs.get(pull.key), run: evidence.runs.get(pull.key), handoff }), evidence.vigil.get(pull.key), ctx.host.now()), prior, evidence.warnings);
        const card = withNewestActivity(prior, projected);
        if (error) { card.error = error; card.activity = "stale"; card.status = "状态暂不可读"; card.detail = error; card.step.index = null; }
        else if (handoffError) { card.error = handoffError; card.activity = "unknown"; card.status = "交接状态待确认"; card.detail = handoffError; card.step.index = null; }
        scan.rows.set(pull.key, card);
      };
      if (!scan.remoteDone) {
        const page = await node<PullPage>(ctx, "pr/board", { scope, ...(scan.cursor ? { cursor: scan.cursor } : {}) });
        if (!page || !page.owner || !Array.isArray(page.rows) || !Number.isFinite(page.total)) throw new KeelError("BOARD_INVALID_RESPONSE", "GitHub 看板响应不完整。");
        const first = scan.cursor === undefined;
        if (!first && scan.owner !== page.owner) throw new KeelError("BOARD_OWNER_CHANGED", "GitHub 账号在分页中变更，已停止混合不同账号的数据。");
        if (first) {
          scan.owner = page.owner;
        }
        scan.total = page.total;
        for (const pull of page.rows) await add(pull);
        if (page.nextCursor && (page.nextCursor === scan.cursor || scan.cursors.has(page.nextCursor))) throw new KeelError("BOARD_CURSOR_LOOP", "GitHub 返回重复分页标记；保留已读 PR，不假装已读完。");
        if (page.nextCursor) scan.cursors.add(page.nextCursor);
        scan.cursor = page.nextCursor ?? undefined;
        scan.remoteDone = page.nextCursor === null;
        if (page.remaining !== undefined && page.remaining < 5) scan.retryAt = Math.max(now + 60_000, Date.parse(page.resetAt ?? "") || 0);
      } else {
        scan.linked ??= missingReferences(scan, evidence.refs);
        const batch = scan.linked.slice(scan.linkedOffset, scan.linkedOffset + 4);
        const previous = new Map(scan.previous?.rows.map((row) => [row.key, row]) ?? []);
        await Promise.all(batch.map(async (ref) => {
          try {
            const pull = await node<RemotePull>(ctx, "pr/board-linked", { repo: ref.repo, number: ref.number });
            if (scope === "all" || pull.state === "OPEN") await add(pull);
          } catch {
            scan.warnings.add("部分 Keel 已关联 PR 无法读取；这些卡片保留并标为待确认。");
            await add(placeholder(ref, previous.get(pullKey(ref.repo, ref.number))), "关联 PR 的 GitHub 状态无法读取，请检查网络或访问权限。");
          }
        }));
        scan.linkedOffset += batch.length;
      }
      if (scan.remoteDone && !scan.linked) scan.linked = missingReferences(scan, evidence.refs);
      const complete = scan.remoteDone && scan.linkedOffset >= (scan.linked?.length ?? 0);
      scan.collecting = !complete;
      const rows = [...scan.rows.values()];
      const warning = [...scan.warnings].join(" ");
      const snapshot: BoardSnapshot = {
        version: 1, scope, owner: scan.owner, rows, total: Math.max(scan.total, rows.length), complete,
        connection: warning || rows.some((row) => row.error) ? "partial" : "live",
        at: now, lastSuccessAt: now, source: "github-viewer-and-keel",
        ...(warning || rows.some((row) => row.error) ? { error: warning ?? "部分关联 PR 的状态尚无法读取。" } : {}),
        ...(scan.retryAt ? { retryAt: scan.retryAt } : {}),
      };
      scan.snapshot = snapshot;
      publishDashboard(ctx.host, scan, snapshot);
      if (complete) {
        const content = JSON.stringify(snapshot);
        if (new TextEncoder().encode(content).length < 12 * 1024 * 1024) {
          const saved = await ctx.host.fs({ op: "write", root: "data", path: `board/dashboard-${scope}.json`, content });
          if (!saved.ok) ctx.host.broadcast({ type: "dashboard-warning", message: "实时数据已读到，但本地缓存未能保存。" });
        }
      }
      return snapshot;
    } catch (error) {
      const code = error instanceof KeelError ? error.code : "BOARD_READ_FAILED";
      const ownerChanged = code === "BOARD_OWNER_CHANGED";
      const previous = ownerChanged ? undefined : scan.snapshot ?? scan.previous;
      const retained = new Map<string, BoardCard>();
      if (ownerChanged) {
        scan.cycle += 1;
        scan.owner = "";
        scan.rows.clear();
        scan.localVersions.clear();
      }
      if (!ownerChanged) {
        if (scan.previous?.owner === scan.owner) for (const row of scan.previous.rows) retained.set(row.key, row);
        if (scan.snapshot?.owner === scan.owner) for (const row of scan.snapshot.rows) retained.set(row.key, row);
        for (const row of scan.rows.values()) retained.set(row.key, row);
      }
      scan.collecting = false;
      scan.retryAt = now + BOARD_REFRESH_MS;
      const snapshot: BoardSnapshot = {
        version: 1, scope, owner: ownerChanged ? "" : scan.owner || previous?.owner || "", rows: [...retained.values()],
        connection: "offline",
        total: previous?.total ?? scan.total, complete: false, at: now, source: "github-viewer-and-keel",
        ...(previous?.lastSuccessAt ? { lastSuccessAt: previous.lastSuccessAt } : {}),
        error: ownerChanged ? "GitHub 账号已变更，正在重新读取，不混用旧账号数据。" : `同步失败（${code}），保留上次数据。请检查 GitHub 登录、网络或 API 配额。`, retryAt: scan.retryAt,
      };
      scan.snapshot = snapshot;
      publishDashboard(ctx.host, scan, snapshot);
      return snapshot;
    }
  };
  scan.inFlight = work();
  try { return await scan.inFlight; } finally { scan.inFlight = undefined; }
}

export function knownDashboardPull(host: Host, key: string): ManagedPull | null {
  for (const scan of hosts.get(host)?.values() ?? []) {
    const row = scan.rows.get(key) ?? scan.snapshot?.rows.find((card) => card.key === key);
    if (row) return { repo: row.repo, number: row.number, at: scan.snapshot?.at ?? 0 };
  }
  return null;
}

export async function updateDashboardLocal(ctx: ToolContext, scope: BoardScope, key: string): Promise<void> {
  const scan = scanFor(ctx.host, scope);
  const row = scan.rows.get(key) ?? scan.snapshot?.rows.find((card) => card.key === key);
  if (!row || !scan.snapshot) return;
  const cycle = scan.cycle;
  const owner = scan.owner;
  const version = (scan.localVersions.get(key) ?? 0) + 1;
  scan.localVersions.set(key, version);
  const evidence = await dashboardEvidence(ctx);
  const handoffContext = await prepareDashboardHandoffContext(ctx);
  const handoff = await currentDashboardHandoff(handoffContext, row);
  if (scan.cycle !== cycle || scan.owner !== owner || scan.localVersions.get(key) !== version) return;
  const current = scan.rows.get(key) ?? scan.snapshot?.rows.find((card) => card.key === key);
  if (current !== row || !scan.snapshot) return;
  const projected = retainVigilOnError(projectVigil(projectPull(row, { now: ctx.host.now(), ref: evidence.refs.get(key), run: evidence.runs.get(key), handoff }), evidence.vigil.get(key), ctx.host.now()), row, evidence.warnings);
  if (row.error) Object.assign(projected, { error: row.error, activity: "stale", detail: row.error, status: "状态暂不可读" });
  if (!scan.collecting || scan.rows.has(key)) scan.rows.set(key, projected);
  scan.snapshot.rows = scan.snapshot.rows.map((card) => card.key === key ? projected : card);
  ctx.host.broadcast({ type: "dashboard-local", scope, generation: scan.generation, epoch, owner: scan.owner, row: projected });
}
