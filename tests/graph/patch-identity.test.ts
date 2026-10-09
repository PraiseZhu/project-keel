import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatch } from "../../src/node/rpc.ts";
import { isChangeGraphDone } from "../../src/main/graph/done.ts";
import type { GraphVerdict } from "../../src/main/graph/verdict.ts";

const dirs: string[] = [];
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "keel-patch-"));
  dirs.push(dir);
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...a], { cwd: dir, stdio: "pipe" }).toString();
  g("init", "-q", "-b", "main");
  return {
    dir,
    g,
    sha: () => g("rev-parse", "HEAD").trim(),
  };
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function pid(dir: string, base: string, head: string) {
  return dispatch("git/patch-id", { repo_dir: dir, base_sha: base, head_sha: head });
}

describe("git/patch-id", () => {
  it("same head, new base, different patch", async () => {
    const r = repo();
    r.g("commit", "-q", "--allow-empty", "-m", "A");
    const a = r.sha();
    writeFileSync(join(r.dir, "one.txt"), "1\n");
    r.g("add", "one.txt");
    r.g("commit", "-q", "-m", "B");
    const b = r.sha();
    writeFileSync(join(r.dir, "two.txt"), "2\n");
    r.g("add", "two.txt");
    r.g("commit", "-q", "-m", "H");
    const h = r.sha();
    const fromA = await pid(r.dir, a, h);
    const fromB = await pid(r.dir, b, h);
    expect(fromA.result).toMatchObject({ ok: true });
    expect(fromB.result).toMatchObject({ ok: true });
    expect((fromA.result as { patch_id: string }).patch_id).not.toBe((fromB.result as { patch_id: string }).patch_id);
    expect(h).toBe(r.sha());
  });

  it("head moved but the patch is the same", async () => {
    const r = repo();
    r.g("commit", "-q", "--allow-empty", "-m", "base");
    const base = r.sha();
    writeFileSync(join(r.dir, "a.txt"), "hello\n");
    r.g("add", "a.txt");
    r.g("commit", "-q", "-m", "one");
    const h1 = r.sha();
    r.g("commit", "--amend", "-q", "-m", "two");
    const h2 = r.sha();
    expect(h1).not.toBe(h2);
    const p1 = await pid(r.dir, base, h1);
    const p2 = await pid(r.dir, base, h2);
    expect(p1.result).toEqual(p2.result);
    expect(p1.result).toMatchObject({ ok: true });
  });

  it("missing objects return ok:false, never 'same'", async () => {
    const r = repo();
    r.g("commit", "-q", "--allow-empty", "-m", "only");
    const head = r.sha();
    const missing = await pid(r.dir, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", head);
    expect(missing.result).toMatchObject({ ok: false });
    expect((missing.result as { reason: string }).reason).toMatch(/找不到|失败|对象/);
  });
});

describe("done next from patch identity", () => {
  const sc = [{ id: "1", hasEvidence: true }];
  const verdict = (over: Partial<GraphVerdict> = {}): GraphVerdict => ({
    repo: "acme/app",
    pr: 1,
    base_ref: "main",
    base_sha: "base1",
    head_sha: "head1",
    patch_id: "patch1",
    level: "unit-test-verified",
    surface: "unit-test",
    by_route: { agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy" },
    by_family: "gpt",
    ...over,
  });

  it("head change or different patch → verify-head; same patch new base → recheck-ci", () => {
    const base = {
      pr_status: "report_mergeable" as const,
      author_families: ["grok"],
      sc,
      openHumanGates: 0,
    };
    expect(isChangeGraphDone({
      ...base,
      verdict: verdict(),
      current: { head_sha: "head2", base_sha: "base1", patch_id: "patch1", patch_ok: true },
    }).next).toBe("verify-head");
    expect(isChangeGraphDone({
      ...base,
      verdict: verdict(),
      current: { head_sha: "head1", base_sha: "base1", patch_id: "patch2", patch_ok: true },
    }).next).toBe("verify-head");
    expect(isChangeGraphDone({
      ...base,
      verdict: verdict(),
      current: { head_sha: "head1", base_sha: "base2", patch_id: "patch1", patch_ok: true },
    }).next).toBe("recheck-ci");
  });
});
