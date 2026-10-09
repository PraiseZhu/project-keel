export const STOP_HOOK_LABELS = {
  installed: "已安装",
  not_installed: "未安装",
  unreadable: "无法读取",
} as const;

export type StopHookInstall = keyof typeof STOP_HOOK_LABELS;

export function renderStopHookStatus(status: { claude_code: StopHookInstall; codex: StopHookInstall }): string {
  return `Claude Code：${STOP_HOOK_LABELS[status.claude_code]}；Codex：${STOP_HOOK_LABELS[status.codex]}`;
}

export function renderClockStatus(status: { state?: string; error?: string; failCount?: number } | null | undefined): string {
  if (status?.state === "running") return "常驻时钟：正常";
  if (status?.state === "crashed") return "常驻时钟：Node 已崩溃，正在拉起";
  if (status?.state === "restart_failed" && (status.failCount ?? 0) >= 3) return "常驻时钟：拉起失败，需要手动重新启用插件";
  if (status?.state === "restart_failed") return `常驻时钟：拉起失败${status.error ? `（${status.error}）` : ""}`;
  return "常驻时钟：未知";
}
