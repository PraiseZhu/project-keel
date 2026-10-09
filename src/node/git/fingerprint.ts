// Workspace content fingerprint: HEAD + porcelain + diff HEAD + untracked file bytes.
// Does not require a clean worktree. Any git failure throws: an unknown fingerprint is never hashed.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ToolError, git } from "../env.ts";

export interface ContentFingerprint {
  readonly head: string;
  readonly status_digest: string;
  readonly content_hash: string;
}

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function splitz(buf: string): string[] {
  return buf.split("\0").map((s) => s.trim()).filter(Boolean);
}

export async function contentFingerprint(p: { repo_dir?: string }): Promise<ContentFingerprint> {
  if (!p.repo_dir || typeof p.repo_dir !== "string") throw new ToolError("INVALID_INPUT", "缺少 repo_dir。");
  const cwd = p.repo_dir;
  const head = (await git(["rev-parse", "HEAD"], { cwd })).trim();
  const status = await git(["status", "--porcelain=v1", "-z"], { cwd });
  // External diff drivers and textconv can fail or rewrite output; --binary keeps binary edits visible.
  const diff = await git(["diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD"], { cwd, maxBuffer: 32 * 1024 * 1024 });
  const others = await git(["ls-files", "--others", "--exclude-standard", "-z"], { cwd });
  const files = splitz(others).sort();
  const parts: string[] = [];
  for (const rel of files) {
    const bytes = await readFile(join(cwd, rel));
    parts.push(`${rel}:${sha256(bytes)}`);
  }
  return {
    head,
    status_digest: sha256(status),
    content_hash: sha256(`${diff}\n${parts.join("\n")}`),
  };
}
