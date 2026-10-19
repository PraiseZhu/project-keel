// Installs the KEEL Stop hook into Claude Code and Codex when the plugin starts.
// Cindy has no uninstall event, so the hook command removes itself: when the gate script inside the
// plugin directory is gone, it strips its own entry (and the keel-node agent) and lets the session end.

import { chmod, copyFile, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultHookConfigPath, isKeelHook } from "./hooks-status.ts";

export type HookTarget = "claude-code" | "codex";
export type EnsureOutcome = "installed" | "updated" | "unchanged" | "skipped" | "unreadable" | "error";
export interface EnsureResult { readonly outcome: EnsureOutcome; readonly config: string; readonly message?: string }

export interface HookPaths {
  /** Installed plugin directory, the parent of node/worker.cjs. */
  readonly pluginDir: string;
  /** KEEL data directory that holds runs/active.json. */
  readonly dataDir: string;
  readonly claudeConfig: string;
  readonly codexConfig: string;
  readonly agentsDir: string;
}

export const GATE_FILE = "hooks/keel-stop-gate.js";
export const AGENT_FILE = "hooks/keel-node.md";
export const AGENT_NAME = "keel-node.md";
const OSA = "/usr/bin/osascript -l JavaScript";
const HOOK_TIMEOUT_S = 5;

/**
 * Runs when the gate script is gone (plugin uninstalled): argv[0] is the config to clean, argv[1] the optional
 * agent file. One line, no single quotes, so it survives shell quoting. stripKeel is also exercised by the tests.
 */
export const CLEANUP_JXA = [
  "function stripKeel(j){",
  "var isK=function(h){return Boolean(h&&typeof h===\"object\"&&typeof h.command===\"string\"&&h.command.indexOf(\"keel-stop-gate\")>=0);};",
  "if(!j||typeof j!==\"object\"||!j.hooks||!Array.isArray(j.hooks.Stop))return j;",
  "var keep=[];",
  "j.hooks.Stop.forEach(function(g){if(!g||typeof g!==\"object\"){keep.push(g);return;}if(!Array.isArray(g.hooks)){if(!isK(g))keep.push(g);return;}var hs=g.hooks.filter(function(h){return !isK(h);});if(hs.length){g.hooks=hs;keep.push(g);}});",
  "if(keep.length)j.hooks.Stop=keep;else delete j.hooks.Stop;",
  "if(!Object.keys(j.hooks).length)delete j.hooks;",
  "return j;}",
  "function run(argv){try{ObjC.import(\"Foundation\");",
  "var s=$.NSString.stringWithContentsOfFileEncodingError(argv[0],$.NSUTF8StringEncoding,null);",
  // Write in place (not atomically) so a symlinked config stays a symlink and keeps its permissions.
  "if(s&&!s.isNil()){var j=stripKeel(JSON.parse(s.js));$(JSON.stringify(j,null,2)+\"\\n\").writeToFileAtomicallyEncodingError(argv[0],false,$.NSUTF8StringEncoding,null);}",
  "if(argv[1])$.NSFileManager.defaultManager.removeItemAtPathError(argv[1],null);",
  "}catch(e){}return \"{}\";}",
].join("");

// POSIX single-quote quoting: the shell expands nothing inside '...'; an embedded ' is closed, escaped and reopened.
export function quote(p: string): string {
  return `'${String(p).replace(/'/g, "'\\''")}'`;
}

export function hookCommand(target: HookTarget, paths: HookPaths): string {
  const gate = path.join(paths.pluginDir, GATE_FILE);
  const index = path.join(paths.dataDir, "runs/active.json");
  const cleanupArgs = [target === "claude-code" ? paths.claudeConfig : paths.codexConfig];
  if (target === "claude-code") cleanupArgs.push(path.join(paths.agentsDir, AGENT_NAME));
  return `G=${quote(gate)}; [ -f "$G" ] && exec ${OSA} "$G" --harness ${target} --index ${quote(index)}; exec ${OSA} -e ${quote(CLEANUP_JXA)} ${cleanupArgs.map(quote).join(" ")}`;
}

/** Replace every KEEL Stop hook with exactly one entry running `command`; other hooks keep their order. */
export function withKeelStop(config: Record<string, unknown>, command: string): { next: Record<string, unknown>; changed: boolean } {
  const hooks = { ...(config.hooks && typeof config.hooks === "object" && !Array.isArray(config.hooks) ? config.hooks as Record<string, unknown> : {}) };
  const stop = Array.isArray(hooks.Stop) ? hooks.Stop as unknown[] : [];
  const mine = { type: "command", command, timeout: HOOK_TIMEOUT_S };
  const keelHooks = stop.flatMap((g) => {
    if (isKeelHook(g)) return [g];
    const inner = g && typeof g === "object" ? (g as { hooks?: unknown }).hooks : undefined;
    return Array.isArray(inner) ? inner.filter(isKeelHook) : [];
  });
  if (keelHooks.length === 1 && JSON.stringify(keelHooks[0]) === JSON.stringify(mine)) return { next: config, changed: false };
  const others = stop.flatMap((g) => {
    if (isKeelHook(g)) return [];
    if (!g || typeof g !== "object" || !Array.isArray((g as { hooks?: unknown }).hooks)) return [g];
    const inner = ((g as { hooks: unknown[] }).hooks).filter((h) => !isKeelHook(h));
    return inner.length ? [{ ...(g as object), hooks: inner }] : [];
  });
  hooks.Stop = [...others, { hooks: [mine] }];
  return { next: { ...config, hooks }, changed: true };
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

/**
 * Replace a config atomically without loosening it: write through a symlink to its target and keep the
 * original permission bits (settings.json is often 0600 and may hold tokens). New files get 0600.
 */
async function writeAtomic(file: string, content: string): Promise<void> {
  const target = await realpath(file).catch(() => file);
  const mode = await stat(target).then((s) => s.mode & 0o777, () => 0o600);
  const tmp = `${target}.keel-tmp-${process.pid}`;
  await writeFile(tmp, content, { encoding: "utf8", mode });
  await chmod(tmp, mode);
  await rename(tmp, target);
}

async function ensureAgent(paths: HookPaths): Promise<void> {
  const src = path.join(paths.pluginDir, AGENT_FILE);
  const dest = path.join(paths.agentsDir, AGENT_NAME);
  const want = await readFile(src, "utf8");
  const have = await readFile(dest, "utf8").catch(() => null);
  if (have === want) return;
  await mkdir(paths.agentsDir, { recursive: true });
  await copyFile(src, dest);
}

export async function ensureHook(target: HookTarget, paths: HookPaths): Promise<EnsureResult> {
  const config = target === "claude-code" ? paths.claudeConfig : paths.codexConfig;
  // Only touch a harness the user actually has: its config directory must already exist.
  if (!(await exists(path.dirname(config)))) return { outcome: "skipped", config, message: "未找到配置目录" };
  if (!(await exists(path.join(paths.pluginDir, GATE_FILE)))) return { outcome: "error", config, message: "插件包里缺少收工钩子脚本" };
  try {
    const text = await readFile(config, "utf8").catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? null : Promise.reject(e)));
    let parsed: unknown = {};
    if (text !== null) {
      try { parsed = JSON.parse(text); } catch { return { outcome: "unreadable", config, message: "配置不是合法 JSON，未改动" }; }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { outcome: "unreadable", config, message: "配置不是 JSON 对象，未改动" };
    }
    if (target === "claude-code") await ensureAgent(paths);
    const { next, changed } = withKeelStop(parsed as Record<string, unknown>, hookCommand(target, paths));
    if (!changed) return { outcome: "unchanged", config };
    const backup = `${config}.keel-backup`;
    if (text !== null && !(await exists(backup))) await writeFile(backup, text, { encoding: "utf8", mode: 0o600 });
    await writeAtomic(config, `${JSON.stringify(next, null, 2)}\n`);
    return { outcome: text !== null && JSON.stringify(parsed).includes("keel-stop-gate") ? "updated" : "installed", config };
  } catch (e) {
    return { outcome: "error", config, message: (e as Error).message };
  }
}

/**
 * Paths for a worker running from <owner>/cindy-brain/<id>/node/ or, after Cindy's namespace migration,
 * <owner>/cindy-brain/_ns/<ns>/<id>/node/ (data then lives in <owner>/ghost-fs/_ns__<ns>__<id>).
 * null when the layout is not Cindy's.
 */
export function defaultHookPaths(workerDir: string, home = os.homedir()): HookPaths | null {
  const pluginDir = path.dirname(workerDir);
  const id = path.basename(pluginDir);
  const parent = path.dirname(pluginDir);
  let owner: string;
  let dataName: string;
  if (path.basename(parent) === "cindy-brain") {
    owner = path.dirname(parent);
    dataName = id;
  } else if (path.basename(path.dirname(parent)) === "_ns" && path.basename(path.dirname(path.dirname(parent))) === "cindy-brain") {
    owner = path.dirname(path.dirname(path.dirname(parent)));
    dataName = `_ns__${path.basename(parent)}__${id}`;
  } else {
    return null;
  }
  return {
    pluginDir,
    dataDir: path.join(owner, "ghost-fs", dataName),
    claudeConfig: defaultHookConfigPath("claude-code", home),
    codexConfig: defaultHookConfigPath("codex", home),
    agentsDir: path.join(home, ".claude", "agents"),
  };
}

export async function ensureHooks(paths: HookPaths | null, platform = process.platform): Promise<{ claude_code: EnsureResult; codex: EnsureResult }> {
  if (platform !== "darwin" || !paths) {
    const skipped: EnsureResult = { outcome: "skipped", config: "", message: platform !== "darwin" ? "仅支持 macOS" : "不在 Cindy 插件目录中运行" };
    return { claude_code: skipped, codex: skipped };
  }
  return { claude_code: await ensureHook("claude-code", paths), codex: await ensureHook("codex", paths) };
}
