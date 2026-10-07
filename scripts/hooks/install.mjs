#!/usr/bin/env node
// Install / uninstall / status for the KEEL Stop hook. Zero extra dependencies.
// Does not run against real configs unless those paths are passed explicitly.

import { copyFile, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MARK = "keel-stop-gate.mjs";
export const ORIGIN_MISSING = "__keel_origin_missing";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const GATE_SCRIPT = path.join(SCRIPT_DIR, "keel-stop-gate.mjs");

export function defaultConfigPath(target) {
  const home = os.homedir();
  if (target === "codex") return path.join(home, "Library/Application Support/Cindy/codex-home/hooks.json");
  if (target === "claude-code") return path.join(home, ".claude/settings.json");
  throw new Error(`unknown target ${target}`);
}

export function defaultOwnersRoot() {
  return path.join(os.homedir(), "Library/Application Support/Cindy/owners");
}

export function parseArgs(argv) {
  const out = { cmd: "", target: "", config: "", dataDir: "", ownersRoot: "", dryRun: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--target" && next) { out.target = next; i++; }
    else if (a === "--config" && next) { out.config = next; i++; }
    else if (a === "--data-dir" && next) { out.dataDir = next; i++; }
    else if (a === "--owners-root" && next) { out.ownersRoot = next; i++; }
    else if (a === "--dry-run") out.dryRun = true;
    else rest.push(a);
  }
  out.cmd = rest[0] ?? "";
  return out;
}

export async function discoverDataDir(ownersRoot) {
  const root = ownersRoot || defaultOwnersRoot();
  let names = [];
  try { names = await readdir(root); }
  catch { names = []; }
  const hits = [];
  for (const name of names) {
    const dir = path.join(root, name, "ghost-fs", "keel");
    try {
      if ((await stat(dir)).isDirectory()) hits.push(dir);
    } catch { /* skip */ }
  }
  if (hits.length === 1) return hits[0];
  const err = new Error(hits.length === 0
    ? `找不到 KEEL 数据目录。传 --data-dir。`
    : `找到 ${hits.length} 个 KEEL 数据目录。传 --data-dir 指定一个。`);
  err.hits = hits;
  throw err;
}

function quote(p) {
  return `"${String(p).replace(/"/g, '\\"')}"`;
}

export function keelCommand(target, indexPath, execPath = process.execPath, script = GATE_SCRIPT) {
  return `${quote(execPath)} ${quote(script)} --harness ${target} --index ${quote(indexPath)}`;
}

export function keelGroup(target, indexPath) {
  return { hooks: [{ type: "command", command: keelCommand(target, indexPath), timeout: 5 }] };
}

function isKeelCommand(cmd) {
  return typeof cmd === "string" && cmd.includes(MARK);
}

function isKeelHook(h) {
  return Boolean(h && typeof h === "object" && isKeelCommand(h.command));
}

function isKeelGroup(g) {
  if (!g || typeof g !== "object") return false;
  if (isKeelHook(g)) return true;
  return Array.isArray(g.hooks) && g.hooks.some(isKeelHook);
}

function stripKeelFromGroup(g) {
  if (isKeelHook(g) && !Array.isArray(g.hooks)) return null;
  if (!Array.isArray(g.hooks)) return g;
  const hooks = g.hooks.filter((h) => !isKeelHook(h));
  if (!hooks.length) return null;
  return { ...g, hooks };
}

export function hasKeelStop(config) {
  const stop = config?.hooks?.Stop;
  return Array.isArray(stop) && stop.some(isKeelGroup);
}

export function mergeKeelStop(config, target, indexPath) {
  const base = config && typeof config === "object" && !Array.isArray(config) ? config : {};
  const hooks = { ...(base.hooks && typeof base.hooks === "object" ? base.hooks : {}) };
  const stop = Array.isArray(hooks.Stop) ? [...hooks.Stop] : [];
  const group = keelGroup(target, indexPath);
  let replaced = false;
  const nextStop = stop.map((g) => {
    if (!isKeelGroup(g)) return g;
    replaced = true;
    if (Array.isArray(g.hooks)) {
      const others = g.hooks.filter((h) => !isKeelHook(h));
      return { ...g, hooks: [...others, ...group.hooks] };
    }
    return group;
  }).filter(Boolean);
  if (!replaced) nextStop.push(group);
  hooks.Stop = nextStop;
  return { ...base, hooks };
}

export function removeKeelStop(config) {
  const base = config && typeof config === "object" && !Array.isArray(config) ? { ...config } : {};
  if (!base.hooks || typeof base.hooks !== "object") return base;
  const hooks = { ...base.hooks };
  if (Array.isArray(hooks.Stop)) {
    hooks.Stop = hooks.Stop.map(stripKeelFromGroup).filter(Boolean);
    if (!hooks.Stop.length) delete hooks.Stop;
  }
  const next = { ...base, hooks };
  if (!Object.keys(hooks).length) delete next.hooks;
  return next;
}

export function isVacuousConfig(config) {
  if (!config || typeof config !== "object") return true;
  const keys = Object.keys(config);
  if (!keys.length) return true;
  if (keys.length === 1 && keys[0] === "hooks") {
    const h = config.hooks;
    if (!h || typeof h !== "object") return true;
    const hk = Object.keys(h);
    if (!hk.length) return true;
    if (hk.length === 1 && hk[0] === "Stop" && Array.isArray(h.Stop) && h.Stop.length === 0) return true;
  }
  return false;
}

function backupName(configPath, at = new Date()) {
  const stamp = at.toISOString().replace(/[:.]/g, "-");
  return `${configPath}.keel-backup-${stamp}`;
}

export async function originWasMissing(configPath) {
  const dir = path.dirname(configPath);
  const prefix = `${path.basename(configPath)}.keel-backup-`;
  let names = [];
  try { names = await readdir(dir); }
  catch { return false; }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    try {
      const j = JSON.parse(await readFile(path.join(dir, name), "utf8"));
      if (j && j[ORIGIN_MISSING] === true) return true;
    } catch { /* not a marker */ }
  }
  return false;
}

export async function readConfig(configPath) {
  if (!existsSync(configPath)) return { existed: false, config: {} };
  const text = await readFile(configPath, "utf8");
  const config = JSON.parse(text);
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`${configPath} 不是 JSON 对象`);
  return { existed: true, config };
}

async function writeJson(file, obj) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}

export async function installHook(opts) {
  const target = opts.target;
  if (target !== "codex" && target !== "claude-code") throw new Error("需要 --target codex|claude-code");
  const configPath = opts.config || defaultConfigPath(target);
  const dataDir = opts.dataDir || await discoverDataDir(opts.ownersRoot);
  const indexPath = path.join(dataDir, "runs/active.json");
  const { existed, config } = await readConfig(configPath);
  const next = mergeKeelStop(config, target, indexPath);
  const rendered = `${JSON.stringify(next, null, 2)}\n`;
  if (opts.dryRun) return { dryRun: true, configPath, existed, content: rendered, next };
  const backup = backupName(configPath);
  if (existed) await copyFile(configPath, backup);
  else await writeJson(backup, { [ORIGIN_MISSING]: true });
  await writeJson(configPath, next);
  return { dryRun: false, configPath, existed, backup, next };
}

export async function uninstallHook(opts) {
  const target = opts.target;
  if (target !== "codex" && target !== "claude-code") throw new Error("需要 --target codex|claude-code");
  const configPath = opts.config || defaultConfigPath(target);
  if (!existsSync(configPath)) return { dryRun: Boolean(opts.dryRun), configPath, existed: false, deleted: false, next: null };
  const { config } = await readConfig(configPath);
  const next = removeKeelStop(config);
  const missing = await originWasMissing(configPath);
  const deleted = missing && isVacuousConfig(next);
  const rendered = deleted ? "" : `${JSON.stringify(next, null, 2)}\n`;
  if (opts.dryRun) return { dryRun: true, configPath, existed: true, deleted, content: rendered, next };
  if (deleted) await unlink(configPath);
  else await writeJson(configPath, next);
  return { dryRun: false, configPath, existed: true, deleted, next };
}

export async function statusHook(opts) {
  const target = opts.target;
  if (target !== "codex" && target !== "claude-code") throw new Error("需要 --target codex|claude-code");
  const configPath = opts.config || defaultConfigPath(target);
  let installed = false;
  try {
    const { existed, config } = await readConfig(configPath);
    installed = existed && hasKeelStop(config);
  } catch { installed = false; }
  const note = target === "codex" ? "需要在 Codex 里信任该钩子" : undefined;
  return { target, configPath, installed, ...(note ? { note } : {}) };
}

function isMain() {
  const self = fileURLToPath(import.meta.url);
  const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
  return self === invoked;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!["install", "uninstall", "status"].includes(opts.cmd)) {
    process.stderr.write("用法: install.mjs install|uninstall|status --target codex|claude-code [--config p] [--data-dir p] [--dry-run]\n");
    process.exit(1);
  }
  if (opts.cmd === "install") {
    const r = await installHook(opts);
    process.stdout.write(r.dryRun ? r.content : `${JSON.stringify({ ok: true, op: "install", config: r.configPath, backup: r.backup ?? null })}\n`);
    return;
  }
  if (opts.cmd === "uninstall") {
    const r = await uninstallHook(opts);
    process.stdout.write(r.dryRun ? (r.content || `${JSON.stringify({ delete: true })}\n`) : `${JSON.stringify({ ok: true, op: "uninstall", config: r.configPath, deleted: r.deleted })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(await statusHook(opts), null, 2)}\n`);
}

if (isMain()) {
  void main().catch((e) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
