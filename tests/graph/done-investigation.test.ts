import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isInvestigationDone } from "../../src/main/graph/done.ts";
import { dispatch } from "../../src/node/rpc.ts";
import type { ContentFingerprint } from "../../src/node/git/fingerprint.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "keel-inv-"));
  dirs.push(dir);
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...a], { cwd: dir, stdio: "pipe" }).toString();
  g("init", "-q", "-b", "main");
  g("commit", "-q", "--allow-empty", "-m", "init");
  return { dir, g };
}

async function fp(dir: string): Promise<ContentFingerprint> {
  const r = await dispatch("git/content-fingerprint", { repo_dir: dir });
  if (r.error) throw new Error(r.error.message);
  return r.result as ContentFingerprint;
}

describe("isInvestigationDone", () => {
  it("can be done with no PR / head / verdict", async () => {
    const r = repo();
    writeFileSync(join(r.dir, "notes.txt"), "already dirty\n");
    const start = await fp(r.dir);
    const again = await fp(r.dir);
    const result = isInvestigationDone({
      reportComplete: true,
      reportCitation: "notes.txt:1",
      sc: [{ id: "SC-1", hasEvidence: true }],
      openHumanGates: 0,
      start,
      current: again,
    });
    expect(result).toEqual({ done: true, missing: [] });
    expect(result).not.toHaveProperty("pr");
    expect(result).not.toHaveProperty("verdict");
  });

  it("changing an already-dirty file is visible in the fingerprint", async () => {
    const r = repo();
    writeFileSync(join(r.dir, "scratch.txt"), "v1\n");
    const start = await fp(r.dir);
    writeFileSync(join(r.dir, "scratch.txt"), "v2\n");
    const current = await fp(r.dir);
    expect(current.content_hash).not.toBe(start.content_hash);
    const result = isInvestigationDone({
      reportComplete: true,
      reportCitation: "doc",
      sc: [{ id: "SC-1", hasEvidence: true }],
      openHumanGates: 0,
      start,
      current,
    });
    expect(result.done).toBe(false);
    expect(result.missing.some((m) => m.includes("指纹"))).toBe(true);
  });

  it("a git failure gives no fingerprint instead of hashing the error output", async () => {
    const r = repo();
    writeFileSync(join(r.dir, "a.txt"), "v1\n");
    r.g("add", "a.txt");
    r.g("commit", "-q", "-m", "a");
    writeFileSync(join(r.dir, "a.txt"), "v2\n");
    // A broken external diff driver must not change or break the fingerprint.
    r.g("config", "diff.external", "false");
    const withDriver = await fp(r.dir);
    r.g("config", "--unset", "diff.external");
    expect((await fp(r.dir)).content_hash).toBe(withDriver.content_hash);

    // Corrupt HEAD: every git read fails, so the RPC must error rather than return a hash.
    writeFileSync(join(r.dir, ".git", "HEAD"), "ref: refs/heads/missing\n");
    const res = await dispatch("git/content-fingerprint", { repo_dir: r.dir });
    expect(res.error).toBeTruthy();
    expect(res.result).toBeUndefined();
  });
});
