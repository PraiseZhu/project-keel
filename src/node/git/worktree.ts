// Worktrees live under <repo>/.worktrees/ (user rule). Audit is read-only; prune only
// removes rows the audit classifies as `safe` (clean + merged), with plain `worktree remove`
// and `branch -d` — never --force, never rm -rf. Ported in spirit from pstack worktree-audit.sh.

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { WorktreeAuditRow } from "../../shared/types.ts";
import { ToolError, ghRaw, git, gitRaw } from "../env.ts";

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Keep KEEL node reports (<worktree>/.keel/) out of `git status`, scope checks and commits. Local only (.git/info/exclude). */
export async function excludeKeelReports(root: string): Promise<void> {
  const common = (await git(["rev-parse", "--git-common-dir"], { cwd: root })).trim();
  const infoDir = resolve(root, common, "info");
  mkdirSync(infoDir, { recursive: true });
  const file = join(infoDir, "exclude");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (current.split("\n").some((l) => l.trim() === ".keel/" || l.trim() === "/.keel/")) return;
  appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}.keel/\n`);
}

/** Refs reach git as argv; a leading "-" would be parsed as an option. */
export function assertRef(ref: string): string {
  if (!ref || ref.startsWith("-") || /[\s~^:?*\[\\]|\.\./.test(ref)) throw new ToolError("INVALID_INPUT", `不是合法的 git 引用：${ref.slice(0, 80)}`);
  return ref;
}

export async function repoRoot(dir: string): Promise<string> {
  const top = (await git(["rev-parse", "--show-toplevel"], { cwd: dir })).trim();
  // Inside a linked worktree, the main repo is the parent of the common dir.
  const common = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir })).trim();
  return common.endsWith(`${sep}.git`) ? common.slice(0, -5) : top;
}

export async function defaultBranch(root: string): Promise<string> {
  const r = await gitRaw(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { cwd: root });
  return r.code === 0 ? r.stdout.trim().replace(/^origin\//, "") : "main";
}

export async function findWorktreeForBranch(root: string, branch: string): Promise<string | null> {
  const list = await git(["worktree", "list", "--porcelain"], { cwd: root });
  let currentPath: string | null = null;
  for (const line of list.split("\n")) {
    if (line.startsWith("worktree ")) currentPath = line.slice(9);
    else if (line.startsWith("branch refs/heads/") && currentPath && line.slice(18) === branch) return currentPath;
    else if (line === "") currentPath = null;
  }
  return null;
}

export async function createWorktree(p: {
  repo_dir: string;
  name: string;
  base_ref?: string;
  branch?: string;
  existing?: boolean;
  head_repo?: string;
}) {
  if (!NAME.test(p.name)) throw new ToolError("INVALID_INPUT", "name 只能含小写字母、数字、点、下划线和连字符。");
  const root = await repoRoot(p.repo_dir);
  mkdirSync(join(root, ".worktrees"), { recursive: true });
  const path = join(root, ".worktrees", p.name);
  if (existsSync(path)) throw new ToolError("UNSAFE_TARGET", `${path} 已存在，换个名字。`);
  if (p.existing) {
    const branch = assertRef(p.branch ?? "");
    const occupied = await findWorktreeForBranch(root, branch);
    if (occupied) return { occupied, branch };
    const remote = p.head_repo && !p.head_repo.startsWith("-") ? p.head_repo : "origin";
    const local = await gitRaw(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: root });
    let start = branch;
    if (local.code !== 0) {
      await gitRaw(["fetch", remote, branch, "--quiet"], { cwd: root, timeoutMs: 120_000 });
      start = `${remote}/${branch}`;
    }
    const add = await gitRaw(["worktree", "add", path, start], { cwd: root, timeoutMs: 120_000 });
    if (add.code !== 0) {
      const msg = `${add.stderr} ${add.stdout}`;
      const hit = msg.match(/already (?:used by worktree at|checked out at) ['"]?([^'"\n]+)/i);
      if (hit || /already (used|checked out)/i.test(msg)) {
        const again = await findWorktreeForBranch(root, branch);
        return { occupied: again ?? hit?.[1]?.trim() ?? "unknown", branch };
      }
      throw new ToolError("WORKTREE_FAILED", (add.stderr || add.stdout).trim().slice(0, 300) || "检出已有分支失败。");
    }
    await excludeKeelReports(root);
    return { path, branch, existing: true };
  }
  const branch = p.branch ?? `keel/${p.name}`;
  const base = assertRef(p.base_ref ?? `origin/${await defaultBranch(root)}`);
  await gitRaw(["fetch", "origin", "--quiet"], { cwd: root, timeoutMs: 120_000 });
  await git(["worktree", "add", "-b", branch, path, base], { cwd: root, timeoutMs: 120_000 });
  await excludeKeelReports(root);
  return { path, branch, base };
}

export interface RawRow {
  readonly path: string;
  readonly branch: string | null;
  readonly ageDays: number | null;
  readonly merged: boolean;
  readonly porcelain: string;
  readonly remote: string;
  readonly prState: string | null;
  readonly prNumber: number | null;
  /** The matched PR's head equals this worktree's HEAD (a reused branch name does not count). */
  readonly prHeadMatches?: boolean;
  readonly recentDays: number | null;
}

export function dirtyOf(porcelain: string): string {
  const lines = porcelain.split("\n").filter(Boolean);
  if (!lines.length) return "clean";
  const tracked = lines.filter((l) => !l.startsWith("??")).length;
  return tracked ? `wip:${tracked}` : `scratch:${lines.length}`;
}

/** Bucket a row. Stricter than upstream: `safe` needs a clean tree and a real merge. */
export function bucketOf(r: RawRow): WorktreeAuditRow["bucket"] {
  const dirty = dirtyOf(r.porcelain);
  if (dirty.startsWith("wip:")) return "hold-wip";
  if (r.prState === "OPEN") return "hold-open-pr";
  if (r.recentDays !== null && r.recentDays <= 4) return "review";
  if (/^ahead[1-9]/.test(r.remote)) return "review";
  if (dirty === "clean" && (r.merged || (r.prState === "MERGED" && r.prHeadMatches === true))) return "safe";
  return "review";
}

/** Read-only unless `refresh` (prune refreshes origin/<main> before deciding what is merged). */
export async function audit(repoDir: string, opts: { refresh?: boolean } = {}): Promise<WorktreeAuditRow[]> {
  const root = await repoRoot(repoDir);
  const main = await defaultBranch(root);
  if (opts.refresh) await gitRaw(["fetch", "origin", main, "--quiet"], { cwd: root, timeoutMs: 120_000 });
  const list = await git(["worktree", "list", "--porcelain"], { cwd: root });
  const paths = list.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
  const prsRaw = await ghRaw(["pr", "list", "--author", "@me", "--state", "all", "--limit", "500", "--json", "number,state,headRefName,headRefOid"], { cwd: root });
  let prs: { number: number; state: string; headRefName: string; headRefOid?: string }[] = [];
  try {
    prs = JSON.parse(prsRaw.stdout || "[]");
  } catch {
    prs = [];
  }
  const now = Date.now();
  const rows: WorktreeAuditRow[] = [];
  for (const wt of paths) {
    if (resolve(wt) === resolve(root)) {
      rows.push({ path: wt, branch: main, ageDays: null, merged: true, dirty: "-", remote: "-", pr: "-", bucket: "main" });
      continue;
    }
    const head = (await gitRaw(["rev-parse", "HEAD"], { cwd: wt })).stdout.trim();
    const ts = Number((await gitRaw(["log", "-1", "--format=%ct", "HEAD"], { cwd: wt })).stdout.trim() || 0);
    const merged = (await gitRaw(["merge-base", "--is-ancestor", head, `origin/${main}`], { cwd: root })).code === 0;
    const porcelain = (await gitRaw(["status", "--porcelain"], { cwd: wt })).stdout;
    const b = await gitRaw(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: wt });
    const branch = b.code === 0 ? b.stdout.trim() : null;
    let remote = "detached";
    if (branch) {
      const rr = await gitRaw(["rev-parse", `origin/${branch}`], { cwd: wt });
      remote = rr.code !== 0 ? "no-remote" : rr.stdout.trim() === head ? "pushed" : `ahead${(await gitRaw(["rev-list", "--count", `origin/${branch}..HEAD`], { cwd: wt })).stdout.trim()}`;
    }
    // Prefer the PR whose head is this commit; a branch name reused after a merge must not inherit "MERGED".
    const pr = branch ? prs.find((x) => x.headRefName === branch && x.headRefOid === head) ?? prs.find((x) => x.headRefName === branch && x.state === "OPEN") ?? prs.find((x) => x.headRefName === branch) ?? null : null;
    let recentDays: number | null = null;
    try {
      recentDays = Math.floor((now - statSync(wt).mtimeMs) / 86_400_000);
    } catch {
      recentDays = null;
    }
    const raw: RawRow = { path: wt, branch, ageDays: ts ? Math.floor((now - ts * 1000) / 86_400_000) : null, merged, porcelain, remote, prState: pr?.state ?? null, prNumber: pr?.number ?? null, prHeadMatches: pr?.headRefOid === head, recentDays };
    rows.push({ path: wt, branch, ageDays: raw.ageDays, merged, dirty: dirtyOf(porcelain), remote, pr: pr ? `#${pr.number}/${pr.state}` : "-", bucket: bucketOf(raw) });
  }
  return rows;
}

export async function prune(repoDir: string, paths: readonly string[]) {
  const rows = await audit(repoDir, { refresh: true });
  const root = await repoRoot(repoDir);
  const removed: string[] = [];
  const refused: { path: string; reason: string }[] = [];
  for (const p of paths) {
    const row = rows.find((r) => resolve(r.path) === resolve(p));
    if (!row) refused.push({ path: p, reason: "不是该仓的 worktree" });
    else if (row.bucket !== "safe") refused.push({ path: p, reason: `审计分类为 ${row.bucket}，只删 safe 行` });
    else {
      const r = await gitRaw(["worktree", "remove", row.path], { cwd: root });
      if (r.code !== 0) { refused.push({ path: p, reason: r.stderr.trim().slice(0, 200) }); continue; }
      if (row.branch) await gitRaw(["branch", "-d", row.branch], { cwd: root });
      removed.push(row.path);
    }
  }
  await gitRaw(["worktree", "prune"], { cwd: root });
  return { removed, refused };
}

/** Fetch origin/<base_ref> if possible, then merge-base with HEAD. Fetch failure is not fatal. */
export async function originBaseSha(p: { repo_dir?: string; base_ref?: string }): Promise<{ base_ref: string; base_sha?: string; fetched: boolean }> {
  if (!p.repo_dir) throw new ToolError("INVALID_INPUT", "缺少 repo_dir。");
  const baseRef = assertRef((p.base_ref || "main").replace(/^origin\//, ""));
  const fetched = (await gitRaw(["fetch", "origin", baseRef, "--quiet"], { cwd: p.repo_dir, timeoutMs: 60_000 })).code === 0;
  const mb = await gitRaw(["merge-base", `origin/${baseRef}`, "HEAD"], { cwd: p.repo_dir });
  const sha = mb.code === 0 ? mb.stdout.trim() : "";
  return { base_ref: baseRef, fetched, ...(sha ? { base_sha: sha } : {}) };
}

export async function gitState(repoDir: string) {
  const root = await repoRoot(repoDir);
  const branch = (await gitRaw(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoDir })).stdout.trim();
  const status = (await gitRaw(["status", "--porcelain"], { cwd: repoDir })).stdout;
  const head = (await gitRaw(["rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim();
  const up = await gitRaw(["rev-list", "--left-right", "--count", "@{u}...HEAD"], { cwd: repoDir });
  const [behind, ahead] = up.code === 0 ? up.stdout.trim().split(/\s+/).map(Number) : [null, null];
  const rem = await gitRaw(["remote", "get-url", "origin"], { cwd: repoDir });
  const m = rem.code === 0 ? rem.stdout.trim().match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/) : null;
  return { root, branch, head, dirty: dirtyOf(status), behind, ahead, upstream: up.code === 0, ...(m ? { gh_repo: `${m[1]}/${m[2]}` } : {}) };
}
