import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ToolError, git, gitRaw } from "../env.ts";
import { repoRoot } from "./worktree.ts";

// -z keeps names byte-exact (no trimming, no quoting); --no-renames lists a rename's source too.
function splitNames(out: string): string[] {
  return out.split("\0").filter(Boolean);
}

export async function changedFiles(p: { repo_dir?: string; base?: string }): Promise<{ files: string[] }> {
  if (!p.repo_dir) throw new ToolError("INVALID_INPUT", "缺少 repo_dir。");
  const cwd = p.repo_dir;
  const diff = ["diff", "--name-only", "--no-renames", "--relative", "-z"];
  // Any failed query throws: a query that could not run is never reported as "no changes".
  const outs = await Promise.all([
    ...(p.base ? [git([...diff, p.base], { cwd })] : []),
    git(diff, { cwd }),
    git([...diff, "--cached"], { cwd }),
    git(["ls-files", "--others", "--exclude-standard", "-z"], { cwd }),
  ]);
  const names = new Set<string>();
  for (const out of outs) for (const n of splitNames(out)) names.add(n);
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
