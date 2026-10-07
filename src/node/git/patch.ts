// Compute a stable patch-id for base...head. Failure is never treated as "same".

import { gitRaw } from "../env.ts";

export type PatchIdResult = { ok: true; patch_id: string } | { ok: false; reason: string };

function asSha(value: unknown, label: string): string | { reason: string } {
  if (typeof value !== "string" || !/^[0-9a-f]{7,40}$/i.test(value) || value.startsWith("-")) {
    return { reason: `${label} 不是合法的 git 对象名。` };
  }
  return value;
}

async function ensureObject(repo: string, sha: string): Promise<boolean> {
  const first = await gitRaw(["cat-file", "-e", sha], { cwd: repo });
  if (first.code === 0) return true;
  await gitRaw(["fetch", "origin", sha, "--quiet"], { cwd: repo, timeoutMs: 60_000 });
  const again = await gitRaw(["cat-file", "-e", sha], { cwd: repo });
  return again.code === 0;
}

export async function patchId(p: { repo_dir?: string; base_sha?: string; head_sha?: string }): Promise<PatchIdResult> {
  if (!p.repo_dir || typeof p.repo_dir !== "string") return { ok: false, reason: "缺少 repo_dir。" };
  const base = asSha(p.base_sha, "base_sha");
  if (typeof base !== "string") return { ok: false, reason: base.reason };
  const head = asSha(p.head_sha, "head_sha");
  if (typeof head !== "string") return { ok: false, reason: head.reason };
  try {
    if (!(await ensureObject(p.repo_dir, base))) return { ok: false, reason: `找不到 base 对象 ${base}。` };
    if (!(await ensureObject(p.repo_dir, head))) return { ok: false, reason: `找不到 head 对象 ${head}。` };
    const diff = await gitRaw(["diff", `${base}...${head}`], { cwd: p.repo_dir, maxBuffer: 32 * 1024 * 1024 });
    if (diff.code !== 0) return { ok: false, reason: (diff.stderr || diff.stdout).trim() || "git diff 失败。" };
    const pid = await gitRaw(["patch-id", "--stable"], { cwd: p.repo_dir, input: diff.stdout });
    if (pid.code !== 0) return { ok: false, reason: (pid.stderr || pid.stdout).trim() || "git patch-id --stable 失败。" };
    const id = pid.stdout.trim().split(/\s+/)[0];
    if (!id) return { ok: false, reason: "git patch-id --stable 没有输出，无法确认补丁身份。" };
    return { ok: true, patch_id: id };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
