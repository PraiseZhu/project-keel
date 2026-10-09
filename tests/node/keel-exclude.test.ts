import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { excludeKeelReports } from "../../src/node/git/worktree.ts";

let dir = "";
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });

function repo(): string {
  dir = mkdtempSync(join(tmpdir(), "keel-exclude-"));
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...a], { cwd: dir, stdio: "pipe" }).toString();
  g("init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "a\n");
  g("add", "a.txt");
  g("commit", "-q", "-m", "init");
  return dir;
}

describe("excludeKeelReports", () => {
  it("hides .keel/ reports from git status in the repo and its worktrees, once", async () => {
    const root = repo();
    const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe" }).toString();
    g(root, "worktree", "add", "-q", "-b", "keel/x", join(root, ".worktrees", "x"));
    await excludeKeelReports(root);
    await excludeKeelReports(root);
    const wt = join(root, ".worktrees", "x");
    mkdirSync(join(wt, ".keel"), { recursive: true });
    writeFileSync(join(wt, ".keel", "reproduce-1.md"), "report\n");
    writeFileSync(join(wt, "b.txt"), "b\n");
    const status = g(wt, "status", "--porcelain");
    expect(status).toContain("b.txt");
    expect(status).not.toContain(".keel");
    const exclude = readFileSync(join(root, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((l) => l === ".keel/")).toHaveLength(1);
  });
});
