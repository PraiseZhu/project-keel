import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatch } from "../../src/node/rpc.ts";
import { checkScope } from "../../src/main/graph/scope.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function repo() {
  mkdirSync("_tmp/test-runs", { recursive: true });
  const dir = mkdtempSync(resolve("_tmp/test-runs/wt-"));
  dirs.push(dir);
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...a], { cwd: dir, stdio: "pipe" }).toString();
  g("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "main\n");
  g("add", "README.md");
  g("commit", "-q", "-m", "init");
  return { dir, g, sha: () => g("rev-parse", "HEAD").trim() };
}

describe("worktree/create existing branch", () => {
  it("checks out an existing branch without -b", async () => {
    const r = repo();
    r.g("branch", "pr-head");
    r.g("checkout", "-q", "pr-head");
    writeFileSync(join(r.dir, "feat.txt"), "x\n");
    r.g("add", "feat.txt");
    r.g("commit", "-q", "-m", "feat");
    const featureSha = r.sha();
    r.g("checkout", "-q", "main");
    const out = await dispatch("worktree/create", { repo_dir: r.dir, name: "pr1", branch: "pr-head", existing: true });
    expect(out.error).toBeUndefined();
    const result = out.result as { path: string; branch: string; existing?: boolean; occupied?: string };
    expect(result.occupied).toBeUndefined();
    expect(result.existing).toBe(true);
    expect(result.branch).toBe("pr-head");
    expect(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: result.path }).toString().trim()).toBe("pr-head");
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: result.path }).toString().trim()).toBe(featureSha);
    expect(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: r.dir }).toString().trim()).toBe("main");
    const branches = execFileSync("git", ["branch", "--list", "keel/*"], { cwd: r.dir }).toString();
    expect(branches.trim()).toBe("");
  });

  it("returns occupied when the branch is already checked out, and never resets", async () => {
    const r = repo();
    r.g("checkout", "-q", "-b", "pr-head");
    writeFileSync(join(r.dir, "dirty.txt"), "keep-me\n");
    const before = r.sha();
    const first = await dispatch("worktree/create", { repo_dir: r.dir, name: "a", branch: "pr-head", existing: true });
    expect(first.result).toMatchObject({ occupied: r.dir, branch: "pr-head" });
    expect(existsSync(join(r.dir, ".worktrees", "a"))).toBe(false);
    expect(readFileSync(join(r.dir, "dirty.txt"), "utf8")).toBe("keep-me\n");
    expect(r.sha()).toBe(before);
    expect(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: r.dir }).toString().trim()).toBe("pr-head");
  });
});

describe("git changed-files / diff / exclude-keel", () => {
  it("lists uncommitted files, diffs, and idempotently ignores .keel/", async () => {
    const r = repo();
    writeFileSync(join(r.dir, "README.md"), "edited\n");
    writeFileSync(join(r.dir, "new.txt"), "u\n");
    const files = await dispatch("git/changed-files", { repo_dir: r.dir, base: "HEAD" });
    expect((files.result as { files: string[] }).files.sort()).toEqual(["README.md", "new.txt"]);
    const diff = await dispatch("git/diff", { repo_dir: r.dir });
    expect((diff.result as { diff: string }).diff).toContain("edited");
    const once = await dispatch("git/exclude-keel", { repo_dir: r.dir });
    expect(once.result).toMatchObject({ added: true });
    const twice = await dispatch("git/exclude-keel", { repo_dir: r.dir });
    expect(twice.result).toMatchObject({ added: false });
    const exclude = readFileSync((once.result as { path: string }).path, "utf8");
    expect(exclude.split("\n").filter((l) => l.trim() === ".keel/")).toHaveLength(1);
  });
});

describe("git changed-files guards the write scope", () => {
  it("lists a rename's source path, so a move out of scope is visible", async () => {
    const r = repo();
    mkdirSync(join(r.dir, "outside"));
    writeFileSync(join(r.dir, "outside", "keep.txt"), "k\n");
    r.g("add", ".");
    r.g("commit", "-q", "-m", "outside");
    mkdirSync(join(r.dir, "allowed"));
    r.g("mv", "outside/keep.txt", "allowed/keep.txt");
    const out = await dispatch("git/changed-files", { repo_dir: r.dir, base: "HEAD" });
    const files = (out.result as { files: string[] }).files;
    expect(files).toContain("outside/keep.txt");
    expect(checkScope(files, ["allowed/**"]).ok).toBe(false);
  });

  it("keeps names byte-exact: a trailing space is a different path", async () => {
    const r = repo();
    writeFileSync(join(r.dir, "allowed.txt "), "x\n");
    const out = await dispatch("git/changed-files", { repo_dir: r.dir });
    const files = (out.result as { files: string[] }).files;
    expect(files).toEqual(["allowed.txt "]);
    expect(checkScope(files, ["allowed.txt"]).ok).toBe(false);
  });

  it("a missing base is an error, not an empty change list", async () => {
    const r = repo();
    const out = await dispatch("git/changed-files", { repo_dir: r.dir, base: "does-not-exist" });
    expect(out.result).toBeUndefined();
    expect(out.error).toBeTruthy();
  });

  it("a backslash in a POSIX file name is not a directory separator", async () => {
    const r = repo();
    writeFileSync(join(r.dir, "src\\outside.txt"), "x\n");
    const out = await dispatch("git/changed-files", { repo_dir: r.dir });
    const files = (out.result as { files: string[] }).files;
    expect(files).toEqual(["src\\outside.txt"]);
    expect(checkScope(files, ["src/**"]).ok).toBe(false);
  });
});
