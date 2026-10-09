import { afterEach, describe, expect, it, vi } from "vitest";
import * as env from "../../src/node/env.ts";
import { prOpen } from "../../src/node/pr/actions.ts";
import { ToolError } from "../../src/node/env.ts";
import { EMPTY_PROFILE, type KeelProfile } from "../../src/shared/types.ts";
import { addWorktree, cleanupRepos, makeRepo } from "../e2e/helpers.ts";
import { mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { git } from "../e2e/helpers.ts";

afterEach(() => {
  vi.restoreAllMocks();
  cleanupRepos();
});

function mkdirBareAndMapGithub(repoDir: string): string {
  const bare = mkdtempSync(resolve("_tmp/test-runs/bare-"));
  git(bare, "init", "--bare", "-q");
  git(repoDir, "remote", "set-url", "--push", "origin", bare);
  return bare;
}

function mockGh(opts: { existing?: { number: number; url: string; isDraft?: boolean }; listError?: Error; titleTypes?: string[] }) {
  const created: string[][] = [];
  const listed: string[][] = [];
  vi.spyOn(env, "ghJson").mockImplementation(async (args: readonly string[]) => {
    if (args[0] === "repo" && args[1] === "view") return { defaultBranchRef: { name: "main" } };
    if (args[0] === "pr" && args[1] === "list") {
      listed.push([...args]);
      if (opts.listError) throw opts.listError;
      return opts.existing ? [{ number: opts.existing.number }] : [];
    }
    if (args[0] === "pr" && args[1] === "view") {
      if (!opts.existing) throw new Error("pr view without existing");
      return { url: opts.existing.url, isDraft: opts.existing.isDraft ?? false };
    }
    throw new Error(`unexpected ghJson ${args.join(" ")}`);
  });
  vi.spyOn(env, "gh").mockImplementation(async (args: readonly string[]) => {
    if (args[0] === "pr" && args[1] === "create") {
      created.push([...args]);
      return "https://github.com/acme/app/pull/42\n";
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  });
  vi.spyOn(env, "ghRaw").mockImplementation(async (args: readonly string[]) => {
    if (args[0] === "api" && String(args[1] ?? "").includes("/contents/")) {
      return { code: 0, stdout: JSON.stringify({ titleTypes: opts.titleTypes ?? ["fix"] }), stderr: "", killed: false, missing: false };
    }
    throw new Error(`unexpected ghRaw ${args.join(" ")}`);
  });
  return { created, listed };
}

const TITLE_PROFILE: KeelProfile = {
  ...EMPTY_PROFILE,
  lanes: [{ repo: "acme/app", preset: "personal", baseRuleFiles: { prRules: "docs/pr-rules.json" } }],
};

describe("prOpen reuses an open PR on the current branch", () => {
  it("push:true still pushes, returns the existing PR, and does not call gh pr create", async () => {
    const { dir } = makeRepo();
    const wt = addWorktree(dir, "reuse-open");
    mkdirBareAndMapGithub(dir);
    const existing = { number: 34, url: "https://github.com/acme/app/pull/34", isDraft: false };
    const { created } = mockGh({ existing });
    const opened = await prOpen(EMPTY_PROFILE, {
      repo_dir: wt,
      title: "fix: login",
      sections: { summary: "reuse" },
      push: true,
    });
    expect(created).toEqual([]);
    expect(opened).toMatchObject({
      url: existing.url,
      number: 34,
      repo: "acme/app",
      reused: true,
    });
    expect(opened.head_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(wt, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}").trim()).toMatch(/origin\//);
  });

  it("creates a PR when the branch has none", async () => {
    const { dir } = makeRepo();
    const wt = addWorktree(dir, "create-open");
    mkdirBareAndMapGithub(dir);
    const { created } = mockGh({});
    const opened = await prOpen(EMPTY_PROFILE, {
      repo_dir: wt,
      title: "fix: login",
      sections: { summary: "new" },
      push: true,
    });
    expect(created).toHaveLength(1);
    expect(created[0]?.slice(0, 2)).toEqual(["pr", "create"]);
    expect(opened).toMatchObject({ url: "https://github.com/acme/app/pull/42", number: 42, repo: "acme/app" });
    expect(opened).not.toHaveProperty("reused");
  });

  it("reuses an existing PR even when the new title would be invalid", async () => {
    const { dir } = makeRepo();
    const wt = addWorktree(dir, "reuse-title");
    mkdirBareAndMapGithub(dir);
    const existing = { number: 34, url: "https://github.com/acme/app/pull/34" };
    const { created, listed } = mockGh({ existing, titleTypes: ["fix"] });
    const opened = await prOpen(TITLE_PROFILE, {
      repo_dir: wt,
      title: "修终审闭环",
      sections: { summary: "reuse" },
      push: true,
    });
    expect(listed.length).toBeGreaterThan(0);
    expect(created).toEqual([]);
    expect(opened).toMatchObject({ number: 34, reused: true, url: existing.url });
    expect(git(wt, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}").trim()).toMatch(/origin\//);
  });

  it("rejects an invalid title before push when there is no PR", async () => {
    const { dir } = makeRepo();
    const wt = addWorktree(dir, "create-title");
    mkdirBareAndMapGithub(dir);
    const { created } = mockGh({ titleTypes: ["fix"] });
    await expect(prOpen(TITLE_PROFILE, {
      repo_dir: wt,
      title: "修终审闭环",
      sections: { summary: "new" },
      push: true,
    })).rejects.toMatchObject({ code: "TITLE_INVALID" });
    expect(created).toEqual([]);
    expect(() => git(wt, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")).toThrow();
  });

  it("does not create when listing the existing PR fails", async () => {
    const { dir } = makeRepo();
    const wt = addWorktree(dir, "list-fail");
    mkdirBareAndMapGithub(dir);
    const { created } = mockGh({ listError: new ToolError("GH_ERROR", "gh pr list 失败") });
    await expect(prOpen(EMPTY_PROFILE, {
      repo_dir: wt,
      title: "fix: login",
      sections: { summary: "x" },
      push: true,
    })).rejects.toMatchObject({ code: "GH_ERROR" });
    expect(created).toEqual([]);
  });
});
