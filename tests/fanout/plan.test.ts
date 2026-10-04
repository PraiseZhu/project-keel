import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { family, planLanes } from "../../src/shared/fanout.ts";
import { dispatch } from "../../src/node/rpc.ts";
import "../../src/node/extensions.ts";
import { tiersFrom } from "../../src/node/fanout/fanout.ts";
import { createWorkersPayload } from "../../src/main/fanout/spec.ts";

const routing = {
  updated: "2026-01-01",
  execute: { agent: "pi", model: "grok-9", effort: "high", provider_id: "p-a", fallbacks: [{ agent: "pi", model: "vendor/grok-9", effort: "high", provider_id: "p-b" }] },
  review: { agent: "claude-code", model: "z/glm-9", effort: "max", provider_id: "p-b", fallbacks: [], when_lead: { "claude-code": { agent: "claude-code", model: "openai/gpt-9", effort: "high", provider_id: "p-b", fallbacks: [{ agent: "claude-code", model: "gpt-9", effort: "high", provider_id: "p-a" }] } } },
  e2e: { agent: "codex", model: "gpt-9-mini", effort: "max", fallbacks: [] },
};
mkdirSync("_tmp/test-runs", { recursive: true });
const dir = mkdtempSync(resolve("_tmp/test-runs/fanout-"));
const routingPath = join(dir, "routing.json");
writeFileSync(routingPath, JSON.stringify(routing));
const repo = join(dir, "repo");
mkdirSync(repo);
const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "pipe" }).toString();
g("init", "-q", "-b", "main");
g("-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
const profile = { lanes: [], routingPath, boardRepos: [], plansDir: null };
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("lane routes come verbatim from routing.json", () => {
  const t = tiersFrom(routing as any);
  it("arena: three candidates across three families plus a cross-judge", () => {
    const lanes = planLanes("arena", t, { leadModel: "claude-opus" });
    expect(lanes.map((l) => l.label)).toEqual(["c1", "c2", "c3", "judge"]);
    expect(new Set(lanes.slice(0, 3).map((l) => family(l.route.model))).size).toBe(3);
    expect(lanes[0]!.route).toMatchObject({ agent: "claude-code", model: "z/glm-9", effort: "max", provider_id: "p-b", tier: "review" });
  });
  it("claude-code lead: seat A uses review.when_lead.claude-code, three families kept", () => {
    const tc = tiersFrom(routing as any, "claude-code");
    const lanes = planLanes("interrogate", tc, { leadModel: "claude-opus" });
    expect(lanes[0]!.route).toMatchObject({ tier: "review.when_lead.claude-code", model: "openai/gpt-9" });
    expect(lanes[0]!.route.fallbacks[0]).toMatchObject({ model: "gpt-9", provider_id: "p-a" });
    expect(new Set(lanes.map((l) => family(l.route.model))).size).toBe(3);
    expect(lanes[2]!.route.tier).toBe("review");
  });
  it("codex lead without its own override uses top-level review; the claude-code override fills seat C", () => {
    const tx = tiersFrom(routing as any, "codex");
    const lanes = planLanes("interrogate", tx, {});
    expect(lanes.map((l) => l.route.tier)).toEqual(["review", "execute", "review.when_lead.claude-code"]);
    expect(lanes.every((l) => !l.note)).toBe(true);
  });
  it("judge avoids the lead's model family", () => {
    const arena = planLanes("arena", tiersFrom(routing as any, "claude-code"), { leadModel: "gpt-9" });
    expect(family(arena.at(-1)!.route.model)).not.toBe("gpt");
  });
  it("rejects an unknown lead_agent instead of guessing", () => {
    expect(() => tiersFrom(routing as any, "gpt")).toThrow(/lead_agent/);
  });
  it("swarm uses execute for slices and e2e for the verifier", () => {
    const lanes = planLanes("swarm", t, { slices: ["api", "ui"] });
    expect(lanes.map((l) => [l.label, l.route.model])).toEqual([["s1", "grok-9"], ["s2", "grok-9"], ["verify", "gpt-9-mini"]]);
  });
  it("create_workers payload copies agent/model/effort/provider_id exactly", () => {
    const lanes = planLanes("interrogate", t, {}).map((l) => ({ ...l, working_dir: null, branch: null }));
    const p = createWorkersPayload("fo-2601010000-abc", "interrogate", lanes, "review x");
    expect(p.workers[0]).toMatchObject({ role: "reviewer", agent: "claude-code", model: "z/glm-9", effort: "max", provider_id: "p-b" });
    for (const w of p.workers) expect(w.label).toMatch(/^[a-z0-9_-]{1,32}$/);
  });
});

describe("fanout/prepare via RPC", () => {
  it("pre-creates write-lane worktrees under <repo>/.worktrees/pstack-*", async () => {
    const out: any = await dispatch("fanout/prepare", { profile, fanout_id: "fo-test-0001", kind: "arena", repo_dir: repo, base_ref: "HEAD", lead_model: "claude-x" });
    expect(out.error).toBeUndefined();
    const cands = out.result.lanes.filter((l: any) => l.write);
    expect(cands).toHaveLength(3);
    for (const c of cands) {
      expect(c.working_dir).toBe(join(repo, ".worktrees", `pstack-fo-test-0001-${c.label}`));
      expect(existsSync(c.working_dir)).toBe(true);
      expect(c.branch).toBe(`pstack/fo-test-0001/${c.label}`);
    }
    expect(out.result.routing.sha256).toMatch(/^[0-9a-f]{64}$/);
    const clean: any = await dispatch("fanout/cleanup", { profile, repo_dir: repo, fanout_id: "fo-test-0001" });
    expect(clean.result.removed).toHaveLength(3);
  });
  it("fails closed when routing.json is unreadable", async () => {
    const out = await dispatch("fanout/prepare", { profile: { ...profile, routingPath: join(dir, "missing.json") }, fanout_id: "fo-test-0002", kind: "interrogate" });
    expect(out.error?.message).toMatch(/^ROUTING_UNREADABLE/);
  });
});

describe("ref guard", () => {
  it("rejects option-shaped or malformed base refs", async () => {
    const { assertRef } = await import("../../src/node/git/worktree.ts");
    expect(() => assertRef("--upload-pack=x")).toThrow();
    expect(() => assertRef("a..b")).toThrow();
    expect(assertRef("origin/main")).toBe("origin/main");
  });
});
