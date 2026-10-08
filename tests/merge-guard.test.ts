import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../src/main/dispatch.ts";
import { methodNames } from "../src/node/rpc.ts";

const manifest = JSON.parse(readFileSync("plugin/ghost.json", "utf8"));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("Keel never merges", () => {
  it("tool table equals ghost.json tools, ≤16, none about merging", () => {
    const declared = manifest.tools.map((t: { name: string }) => t.name).sort();
    expect(Object.keys(TOOLS).sort()).toEqual(declared);
    expect(declared.length).toBeLessThanOrEqual(16);
    expect(declared.some((n: string) => /merge/i.test(n))).toBe(false);
  });
  it("node method table has no merge", () => {
    expect(methodNames().some((n) => /merge/i.test(n))).toBe(false);
  });
  it("no source file calls a merge API", () => {
    const hits = walk("src").filter((f) => /pr merge|mergePullRequest|enablePullRequestAutoMerge|auto-merge/.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
});
