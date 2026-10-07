import { ToolError, gh, ghJson, ghRaw, git } from "../env.ts";
import { originRepo } from "../pr/snapshot.ts";

export const FAILED_LOG_DEFAULT_BYTES = 32_000;
export const FAILED_LOG_MAX_BYTES = 100_000;

export function truncateTail(text: string, maxBytes: number): string {
  const cap = Math.min(Math.max(1, maxBytes), FAILED_LOG_MAX_BYTES);
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= cap) return text;
  return buf.subarray(buf.length - cap).toString("utf8");
}

export async function failedLog(p: { repo_dir?: string; repo?: string; max_bytes?: number }): Promise<{ sha: string; jobs: unknown[]; log: string; truncated: boolean }> {
  if (!p.repo_dir) throw new ToolError("INVALID_INPUT", "缺少 repo_dir。");
  const sha = (await git(["rev-parse", "HEAD"], { cwd: p.repo_dir })).trim();
  const repo = p.repo ?? (await originRepo(p.repo_dir));
  const max = Math.min(p.max_bytes ?? FAILED_LOG_DEFAULT_BYTES, FAILED_LOG_MAX_BYTES);
  const runs = await ghJson<{ databaseId: number; conclusion: string | null; status: string; name: string }[]>([
    "run", "list", "--commit", sha, "--repo", repo, "--json", "databaseId,conclusion,status,name", "--limit", "20",
  ]);
  const failed = (Array.isArray(runs) ? runs : []).filter((r) => r.conclusion === "failure" || r.conclusion === "timed_out" || r.conclusion === "cancelled");
  if (!failed.length) return { sha, jobs: [], log: "", truncated: false };
  const id = failed[0]!.databaseId;
  const raw = await ghRaw(["run", "view", String(id), "--repo", repo, "--log-failed"], { timeoutMs: 60_000, maxBuffer: 8 * 1024 * 1024 });
  if (raw.code !== 0) {
    const fallback = await gh(["run", "view", String(id), "--repo", repo, "--log"], { timeoutMs: 60_000, maxBuffer: 8 * 1024 * 1024 }).catch(() => "");
    const log = truncateTail(fallback, max);
    return { sha, jobs: failed, log, truncated: Buffer.byteLength(fallback, "utf8") > max };
  }
  const log = truncateTail(raw.stdout, max);
  return { sha, jobs: failed, log, truncated: Buffer.byteLength(raw.stdout, "utf8") > max };
}
