import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ToolError, git, gitRaw } from "../env.ts";
import { repoRoot } from "./worktree.ts";

function splitNames(out: string): string[] {
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

export async function changedFiles(p: { repo_dir?: string; base?: string }): Promise<{ files: string[] }> {
  if (!p.repo_dir) throw new ToolError("INVALID_INPUT", "缺少 repo_dir。");
  const cwd = p.repo_dir;
  const names = new Set<string>();
  if (p.base) {
    const vsBase = await gitRaw(["diff", "--name-only", "--relative", p.base], { cwd });
    if (vsBase.code === 0) for (const n of splitNames(vsBase.stdout)) names.add(n);
  }
  const unstaged = await gitRaw(["diff", "--name-only", "--relative"], { cwd });
  const staged = await gitRaw(["diff", "--name-only", "--cached", "--relative"], { cwd });
  const untracked = await gitRaw(["ls-files", "--others", "--exclude-standard"], { cwd });
  for (const n of splitNames(unstaged.stdout)) names.add(n);
  for (const n of splitNames(staged.stdout)) names.add(n);
  for (const n of splitNames(untracked.stdout)) names.add(n);
  return { files: [...names].sort() };
}

export async function gitDiff(p: { repo_dir?: string; base?: string; max_bytes?: number }): Promise<{ diff: string; truncated: boolean }> {
  if (!p.repo_dir) throw new ToolError("INVALID_INPUT", "缺少 repo_dir。");
  const args = p.base ? ["diff", p.base] : ["diff"];
  const r = await gitRaw(args, { cwd: p.repo_dir, maxBuffer: 32 * 1024 * 1024 });
  if (r.code !== 0) throw new ToolError("GIT_ERROR", (r.stderr || r.stdout).trim() || "git diff 失败。");
  const max = Math.min(Math.max(p.max_bytes ?? 200_000, 1024), 1_000_000);
  const buf = Buffer.from(r.stdout, "utf8");
  if (buf.length <= max) return { diff: r.stdout, truncated: false };
  return { diff: buf.subarray(0, max).toString("utf8"), truncated: true };
}

export async function excludeKeel(p: { repo_dir?: string }): Promise<{ path: string; added: boolean }> {
  if (!p.repo_dir) throw new ToolError("INVALID_INPUT", "缺少 repo_dir。");
  const common = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: p.repo_dir })).trim();
  const file = join(common, "info", "exclude");
  mkdirSync(dirname(file), { recursive: true });
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    text = "";
  }
  const lines = text.split(/\r?\n/);
  if (lines.some((l) => l.trim() === ".keel/" || l.trim() === ".keel")) {
    return { path: file, added: false };
  }
  const next = `${text.endsWith("\n") || !text ? text : `${text}\n`}.keel/\n`;
  writeFileSync(file, next);
  return { path: file, added: true };
}

export { repoRoot };
