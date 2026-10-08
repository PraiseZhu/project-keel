// Read-only Stop-hook detection. Recognition matches scripts/hooks/install.mjs (MARK / hasKeelStop).

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const KEEL_STOP_MARK = "keel-stop-gate.mjs";
export type StopHookInstall = "installed" | "not_installed" | "unreadable";

function isKeelCommand(cmd: unknown): boolean {
  return typeof cmd === "string" && cmd.includes(KEEL_STOP_MARK);
}

function isKeelHook(h: unknown): boolean {
  return Boolean(h && typeof h === "object" && isKeelCommand((h as { command?: unknown }).command));
}

function isKeelGroup(g: unknown): boolean {
  if (!g || typeof g !== "object") return false;
  if (isKeelHook(g)) return true;
  const hooks = (g as { hooks?: unknown }).hooks;
  return Array.isArray(hooks) && hooks.some(isKeelHook);
}

/** Same rule as scripts/hooks/install.mjs hasKeelStop. */
export function hasKeelStop(config: unknown): boolean {
  const stop = (config as { hooks?: { Stop?: unknown } } | null)?.hooks?.Stop;
  return Array.isArray(stop) && stop.some(isKeelGroup);
}

export function defaultHookConfigPath(target: "claude-code" | "codex"): string {
  const home = os.homedir();
  if (target === "codex") return path.join(home, "Library/Application Support/Cindy/codex-home/hooks.json");
  return path.join(home, ".claude/settings.json");
}

export function statusFromConfigText(text: string): StopHookInstall {
  try {
    return hasKeelStop(JSON.parse(text) as unknown) ? "installed" : "not_installed";
  } catch {
    return "unreadable";
  }
}

export async function readStopHookStatus(configPath: string): Promise<StopHookInstall> {
  try {
    return statusFromConfigText(await readFile(configPath, "utf8"));
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "not_installed" : "unreadable";
  }
}

export async function bothStopHookStatuses(paths?: {
  claude_config?: string;
  codex_config?: string;
}): Promise<{ claude_code: StopHookInstall; codex: StopHookInstall }> {
  const claude = paths?.claude_config || defaultHookConfigPath("claude-code");
  const codex = paths?.codex_config || defaultHookConfigPath("codex");
  return {
    claude_code: await readStopHookStatus(claude),
    codex: await readStopHookStatus(codex),
  };
}
