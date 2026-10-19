// Read-only Stop-hook detection. src/node/hooks-install.ts and the self-cleanup in the hook command use the same mark.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Matches the current gate (keel-stop-gate.js) and older manual installs (keel-stop-gate.mjs). */
export const KEEL_STOP_MARK = "keel-stop-gate";
export type StopHookInstall = "installed" | "not_installed" | "unreadable";

function isKeelCommand(cmd: unknown): boolean {
  return typeof cmd === "string" && cmd.includes(KEEL_STOP_MARK);
}

/** Gate script path of a hook written by hooks-install (G='<path>'; ...); null for older manual installs. */
export function gatePathOf(cmd: string): string | null {
  const m = /^G='((?:[^']|'\\'')*)';/.exec(cmd);
  return m ? m[1].replace(/'\\''/g, "'") : null;
}

/** A KEEL hook whose gate script is gone only cleans itself up; it does not gate anything. */
function isLiveKeelHook(h: unknown, fileExists: (p: string) => boolean): boolean {
  if (!isKeelHook(h)) return false;
  const gate = gatePathOf((h as { command: string }).command);
  return gate === null || fileExists(gate);
}

export function isKeelHook(h: unknown): boolean {
  return Boolean(h && typeof h === "object" && isKeelCommand((h as { command?: unknown }).command));
}

function isKeelGroup(g: unknown): boolean {
  if (!g || typeof g !== "object") return false;
  if (isKeelHook(g)) return true;
  const hooks = (g as { hooks?: unknown }).hooks;
  return Array.isArray(hooks) && hooks.some(isKeelHook);
}

export function hasKeelStop(config: unknown): boolean {
  const stop = (config as { hooks?: { Stop?: unknown } } | null)?.hooks?.Stop;
  return Array.isArray(stop) && stop.some(isKeelGroup);
}

function hasLiveKeelStop(config: unknown, fileExists: (p: string) => boolean): boolean {
  const stop = (config as { hooks?: { Stop?: unknown } } | null)?.hooks?.Stop;
  if (!Array.isArray(stop)) return false;
  return stop.some((g) => {
    if (isLiveKeelHook(g, fileExists)) return true;
    const hooks = g && typeof g === "object" ? (g as { hooks?: unknown }).hooks : undefined;
    return Array.isArray(hooks) && hooks.some((h) => isLiveKeelHook(h, fileExists));
  });
}

export function defaultHookConfigPath(target: "claude-code" | "codex", home = os.homedir()): string {
  if (target === "codex") return path.join(home, "Library/Application Support/Cindy/codex-home/hooks.json");
  return path.join(home, ".claude/settings.json");
}

export function statusFromConfigText(text: string, fileExists: (p: string) => boolean = existsSync): StopHookInstall {
  try {
    return hasLiveKeelStop(JSON.parse(text) as unknown, fileExists) ? "installed" : "not_installed";
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
