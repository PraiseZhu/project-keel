#!/usr/bin/env node
// KEEL Stop hook: block the lead from ending while a run in this cwd is still active.
// Zero dependencies. Read-only. Fail-open. Stdout is always a single JSON object.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MARK = "keel-stop-gate.mjs";
export const ALLOW_STATUS = new Set(["done", "stopped", "stalled", "paused", "waiting_human"]);

export function parseArgs(argv) {
  const out = { harness: "", index: "", timeoutMs: 5000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--harness" && next) { out.harness = next; i++; }
    else if (a === "--index" && next) { out.index = next; i++; }
    else if (a === "--timeout-ms" && next) { out.timeoutMs = Math.max(1, Number(next) || 5000); i++; }
  }
  return out;
}

function norm(p) {
  if (typeof p !== "string" || !p) return "";
  const n = path.normalize(p);
  return n.length > 1 && (n.endsWith("/") || n.endsWith("\\")) ? n.slice(0, -1) : n;
}

export function matchWorkdir(cwd, index) {
  const c = norm(cwd);
  if (!c || !index || typeof index !== "object") return null;
  let best = null;
  let bestLen = -1;
  for (const [workdir, row] of Object.entries(index)) {
    const w = norm(workdir);
    if (!w) continue;
    if (c === w || c.startsWith(`${w}/`) || c.startsWith(`${w}\\`)) {
      if (w.length > bestLen) { best = row && typeof row === "object" ? { workdir: w, ...row } : null; bestLen = w.length; }
    }
  }
  return best;
}

function under(cwd, dir) {
  const c = norm(cwd);
  const w = norm(dir);
  return Boolean(c && w && (c === w || c.startsWith(`${w}/`) || c.startsWith(`${w}\\`)));
}

export function evaluate(event, index) {
  const active = event?.stop_hook_active;
  if (active === true || active === "true") return { action: "allow", why: "stop_hook_active" };
  if (index === null || index === undefined) return { action: "allow", why: "no_index" };
  if (typeof index !== "object" || Array.isArray(index)) return { action: "allow", why: "no_index" };
  const cwd = typeof event?.cwd === "string" ? event.cwd : "";
  // Sessions inside a run's worktree are KEEL workers; only the lead is gated.
  if (Object.values(index).some((row) => row && typeof row === "object" && under(cwd, row.worktree))) {
    return { action: "allow", why: "worker_worktree" };
  }
  const hit = matchWorkdir(cwd, index);
  if (!hit) return { action: "allow", why: "cwd_mismatch" };
  if (ALLOW_STATUS.has(String(hit.status ?? ""))) return { action: "allow", why: "terminal_status" };
  return { action: "block", run_id: String(hit.run_id ?? ""), current_node: String(hit.current_node || "—") };
}

export function formatOutput(harness, result) {
  if (result.action !== "block") return {};
  const reason = `KEEL：run ${result.run_id} 未完成（${result.current_node}）。如果你是 KEEL 派出的 worker（任务说明里有 dispatch_key），交完报告直接结束，不要调用 keel_*；如果你是主控，先调用 keel_status 取下一步，照 next 执行。`;
  if (harness === "codex") return { decision: "block", reason, continue: true };
  return { decision: "block", reason };
}

export function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

export async function loadIndex(indexPath) {
  if (typeof indexPath !== "string" || !indexPath) return null;
  const text = await readFile(indexPath, "utf8");
  return JSON.parse(text);
}

export async function runStopGate(opts, stdinText) {
  let event = {};
  try { event = stdinText.trim() ? JSON.parse(stdinText) : {}; }
  catch { return formatOutput(opts.harness, { action: "allow", why: "bad_event" }); }
  let index = null;
  try { index = await loadIndex(opts.index); }
  catch { return formatOutput(opts.harness, { action: "allow", why: "no_index" }); }
  return formatOutput(opts.harness, evaluate(event, index));
}

function isMain() {
  const self = fileURLToPath(import.meta.url);
  const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
  return self === invoked;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const timer = setTimeout(() => { try { emit({}); } catch { /* ignore */ } process.exit(0); }, opts.timeoutMs);
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const stdinText = Buffer.concat(chunks.map((c) => Buffer.isBuffer(c) ? c : Buffer.from(c))).toString("utf8");
    emit(await runStopGate(opts, stdinText));
  } catch {
    emit({});
  } finally {
    clearTimeout(timer);
  }
}

if (isMain()) {
  void main().catch(() => { try { emit({}); } catch { /* ignore */ } process.exit(0); });
}
