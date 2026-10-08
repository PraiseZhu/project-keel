// Read-only Stop-hook detection. Recognition is hasKeelStop from install.mjs.

import { readFile } from "node:fs/promises";
import { defaultConfigPath, hasKeelStop } from "../../scripts/hooks/install.mjs";

export type StopHookInstall = "installed" | "not_installed" | "unreadable";

export function statusFromConfigText(text: string): StopHookInstall {
  try {
    const config = JSON.parse(text) as unknown;
    return hasKeelStop(config) ? "installed" : "not_installed";
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
  const claude = paths?.claude_config || defaultConfigPath("claude-code");
  const codex = paths?.codex_config || defaultConfigPath("codex");
  return {
    claude_code: await readStopHookStatus(claude),
    codex: await readStopHookStatus(codex),
  };
}
