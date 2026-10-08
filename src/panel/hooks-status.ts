export const STOP_HOOK_LABELS = {
  installed: "已安装",
  not_installed: "未安装",
  unreadable: "无法读取",
} as const;

export type StopHookInstall = keyof typeof STOP_HOOK_LABELS;

export function renderStopHookStatus(status: { claude_code: StopHookInstall; codex: StopHookInstall }): string {
  return `Claude Code：${STOP_HOOK_LABELS[status.claude_code]}；Codex：${STOP_HOOK_LABELS[status.codex]}`;
}
