import { BOARD_COLUMNS, pullUrl, type BoardCard, type BoardActivity } from "../shared/dashboard.ts";
import { DASHBOARD_ICONS } from "./dashboard-icons.ts";
import { ageLabel, cardState } from "./dashboard-model.ts";

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

export function icon(name: string, className = ""): string {
  const shape = DASHBOARD_ICONS[name] ?? DASHBOARD_ICONS["state-unknown"]!;
  return `<svg class="icon ki ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path class="ic-m" d="${shape.path}"${shape.dashed ? ' stroke-dasharray="2.2 3.2"' : ""}/>${shape.accent ? `<path class="ic-a" pathLength="1" d="${shape.accent}"/>` : ""}${(shape.dots ?? []).map(([horizontal, vertical, radius]) => `<circle class="ic-dot" cx="${horizontal}" cy="${vertical}" r="${radius}"/>`).join("")}</svg>`;
}

export function vigilDetails(row: BoardCard): string {
  if (!row.vigil) return "";
  const progress = row.vigil;
  const paths = [["任务记录", progress.paths.task], ["活动记录", progress.paths.activity], ["处理结果", progress.paths.result], ["验证回执", progress.paths.validation]];
  const notes = progress.notes?.length ? `<h3>最近处理记录</h3><ul>${progress.notes.map((note) => `<li><time>${escapeHtml(note.at)}</time> ${escapeHtml(note.summary)}</li>`).join("")}</ul>` : "";
  return `<section aria-label="Vigil 任务记录"><h3>Vigil 修复任务</h3><dl><dt>任务编号</dt><dd><code>${escapeHtml(progress.dispatchId)}</code></dd><dt>任务起始提交</dt><dd><code>${escapeHtml(progress.sourceHead)}</code></dd>${paths.filter((entry) => entry[1]).map(([label, path]) => `<dt>${label}</dt><dd><code>${escapeHtml(path)}</code></dd>`).join("")}</dl>${notes}<p>记录位置可复制后打开；原修复对话包含实时命令输出和完整审查报告。</p></section>`;
}

const activityNames: Record<BoardActivity, string> = {
  running: "任务在途", waiting: "等待继续推进", "needs-human": "需要你介入", stale: "活动待确认", unknown: "流程待确认",
  ready: "已就绪", "handed-off": "已交接", paused: "工作流已暂停", done: "本轮已结束", closed: "PR 已结束",
};

function marker(activity: BoardActivity): string {
  const content = activity === "running" ? '<i class="running-ring" aria-hidden="true"></i>'
    : activity === "waiting" ? '<span class="waiting-bars" aria-hidden="true"><i></i><i></i><i></i></span>'
    : icon(activity === "needs-human" ? "state-human" : activity === "handed-off" ? "state-handoff" : activity === "ready" || activity === "closed" || activity === "done" ? "state-ready" : activity === "paused" || activity === "stale" ? "state-pause" : "state-unknown", "state-icon");
  return `<span class="card-activity" data-activity-indicator="${activity}" role="img" aria-label="${activityNames[activity]}">${content}</span>`;
}

export function steps(row: BoardCard, activity: BoardActivity): string {
  const index = activity === "stale" ? null : row.step.index;
  const known = index !== null && index >= 0 && index < row.step.labels.length;
  const tone = activity === "running" ? "t-run" : activity === "waiting" ? "t-wait" : activity === "needs-human" ? "t-human" : "t-idle";
  const label = known ? `第 ${index! + 1} 步，共 ${row.step.labels.length} 步：${row.step.labels[index!]}` : "当前子步骤尚未确认";
  return `<span class="card-steps ${known ? tone : "t-unknown"}" role="img" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"><span class="step-no">${known ? `步骤 ${index! + 1}/${row.step.labels.length}` : "步骤 ?"}</span><span class="step-line">${row.step.labels.map((_label, position) => `<i class="sl${known && position === index ? " cur" : ""}${known && row.step.linear && position < index! ? " done" : ""}"></i>`).join("")}</span></span>`;
}

export function cardBody(row: BoardCard, now: number): string {
  const { activity, status, detail } = cardState(row, now);
  const lifecycle = row.state === "MERGED" ? "已合并" : row.state === "CLOSED" ? "已关闭" : row.state === "UNKNOWN" ? "待确认" : row.isDraft ? "草案" : "正式";
  const at = row.activityAt ?? (Date.parse(row.updatedAt) || undefined);
  const kind = row.activityAt ? "活动" : "GitHub";
  return `<i class="card-sheen" aria-hidden="true"></i><div class="card-top"><span class="pr-lifecycle ${row.isDraft ? "is-draft" : "is-open"}">${lifecycle}</span><a class="repo" href="${pullUrl(row.repo, row.number)}" target="_blank" rel="noopener noreferrer" aria-label="在 GitHub 打开 ${escapeHtml(row.repo)} #${row.number}"><span class="repo-name" title="${escapeHtml(row.repo)}">${escapeHtml(row.repo)}</span><b>#${row.number}</b></a><span class="card-state-cluster"><span class="status-text" title="${escapeHtml(status)}">${escapeHtml(status)}</span>${marker(activity)}</span></div><h3 class="card-title"><button type="button" data-action="detail" title="${escapeHtml(row.sessionLabel)}">${escapeHtml(row.sessionLabel)}</button></h3><div class="card-support ${activity === "needs-human" ? "attention" : "muted"}" tabindex="0" title="${escapeHtml(detail)}"><span class="support-label">${row.error ? "读取状态" : row.vigil ? "Vigil 任务记录" : row.stage === "handoff" ? "责任归属" : row.runId ? "工作流记录" : "GitHub 事实"}${ciMeter(row)}</span><span class="support-text">${escapeHtml(detail)}</span></div><div class="card-footer">${steps(row, activity)}<time class="last-activity" data-time="${at ?? ""}" data-kind="${kind}" title="${at ? new Date(at).toLocaleString() : "尚无活动时间"}">${kind} · ${ageLabel(at, now)}</time></div>`;
}

function ciMeter(row: BoardCard): string {
  const counts = row.ci;
  if (!counts || !Number.isFinite(counts.total) || counts.total <= 0) return "";
  const known = counts.passed + counts.failed + counts.pending;
  if (!counts.complete) return `<span class="ci-note">CI 明细 ${known}/${counts.total}</span>`;
  const label = `CI：成功/中性/跳过 ${counts.passed}，未通过 ${counts.failed}，等待 ${counts.pending}，共 ${counts.total} 项`;
  if (counts.total > 16) return `<span class="ci-note" title="${escapeHtml(label)}">CI ${counts.passed}/${counts.total}${counts.failed ? ` · ${counts.failed} 未通过` : ""}</span>`;
  return `<span class="ci-meter" role="img" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${Array.from({ length: counts.total }, (_value, index) => `<i class="${index < counts.passed ? "passed" : index < counts.passed + counts.failed ? "failed" : "pending"}"></i>`).join("")}</span>`;
}

export function heading(column: typeof BOARD_COLUMNS[number], count: number, focused: boolean): string {
  return `<div class="column-heading"><div class="stage-row"><button class="flow-node" type="button" data-flow-node="${column.id}" aria-label="聚焦${column.label}" aria-pressed="${focused}"><span class="node-icon">${icon(column.icon)}</span></button><span class="node-label">${column.label}</span><span class="node-owner" title="责任分段，不凭此推断当前进程所在电脑">${column.owner}</span><span class="column-count">${count}</span>${column.id !== "handoff" ? `<span class="flow-connector ${column.id === "cloud" ? "conditional-connector" : ""}" aria-hidden="true"><i></i></span>` : ""}</div></div>`;
}

export function dashboardMarkup(): string {
  return `<main class="kb offline-mode" aria-label="Keel PR 推进看板"><div class="toolbar"><div class="filter-tabs" role="group" aria-label="PR 筛选">${[["all", "所有 PR"], ["running", "自动推进"], ["attention", "需要我"]].map(([key, label]) => `<button class="filter-tab${key === "all" ? " selected" : ""}" data-filter="${key}" aria-pressed="${key === "all"}">${label}<span class="count">0</span></button>`).join("")}</div><div class="right-tools"><label class="scope-control"><span class="sr-only">显示范围</span><select id="scope-filter" aria-label="显示范围"><option value="open">进行中的 PR</option><option value="all">包含已合并 / 关闭</option></select></label><div class="repo-menu"><button type="button" class="repo-trigger" id="repo-filter" aria-haspopup="menu" aria-expanded="false" aria-controls="repo-list"><span class="repo-trigger-label">所有仓库</span>${icon("chevron", "repo-chevron")}</button><div class="repo-list" id="repo-list" role="menu" aria-label="仓库" hidden></div></div><label class="search">${icon("search")}<input id="board-search" aria-label="搜索 PR、仓库或任务" placeholder="搜索 PR 或任务"><button type="button" class="search-clear" aria-label="清除搜索" tabindex="-1">${icon("close")}</button></label><button type="button" id="board-refresh" class="refresh-control" aria-label="立即刷新 GitHub 状态" title="立即刷新">${icon("stage-loop")}</button></div></div><div class="banner" id="board-warning" role="status" hidden></div><div class="board-shell"><div class="board-header-viewport" aria-label="流程节点" hidden><div class="board-header-track"></div></div><div class="board-scroll" tabindex="0" aria-label="PR 卡片列表"><div class="columns" style="--column-count:3" hidden></div><div class="empty-board" id="board-empty" hidden></div></div></div><footer class="board-footer"><span class="footer-l"><span class="sync-state" id="sync-state"><i></i><span>正在连接</span></span><span>·</span><span id="last-sync">尚未读取 GitHub</span><span class="last-event" id="coverage-note"></span></span><span id="board-owner" title="不限仓库；包含当前账号的全部作者 PR 和本机 Keel 已记录的关联 PR"></span></footer></main><dialog id="pr-detail" aria-labelledby="detail-title"><div class="detail-top"><h2 id="detail-title">PR 详情</h2><button type="button" data-close-detail aria-label="关闭详情">${icon("close")}</button></div><div id="detail-body"></div></dialog>`;
}
