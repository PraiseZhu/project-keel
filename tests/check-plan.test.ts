import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkPlan } from "../src/node/plan/check-plan.ts";
import { dispatch } from "../src/node/rpc.ts";
import "../src/node/extensions.ts";

describe("check-plan port", () => {
  it("keeps upstream rules verbatim", () => {
    const src = readFileSync("src/node/plan/check-plan.ts", "utf8");
    for (const s of ["Tests alone are not sufficient verification.", '"Verify, unit."', '"Review gate."', "mid-sentence colon", "long dash", "curly quote"]) expect(src).toContain(s);
  });
  it("flags typography and missing structure", () => {
    const r = checkPlan("# Plan\n\nA line with a dash — here and “quotes”.\n", "p.md");
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.includes("long dash"))).toBe(true);
    expect(r.problems.some((p) => p.includes("curly quote"))).toBe(true);
    expect(r.problems.some((p) => p.includes("no PR sections"))).toBe(true);
  });
  it("ignores fenced code", () => {
    const r = checkPlan("```\nx — y\n```\n", "p.md");
    expect(r.problems.some((p) => p.includes("long dash"))).toBe(false);
  });
  it("accepts a Cindy scheduler heartbeat in place of Cursor's /loop 1h", () => {
    const loop = (body: string) => checkPlan(`# P\n\n## Program checklist\n\n${body}\n`, "p.md").problems.some((p) => p.includes('lacks "/loop 1h"'));
    expect(loop("nothing here")).toBe(true);
    expect(loop("arm `/loop 1h`")).toBe(false);
    expect(loop("arm a schedule_create heartbeat")).toBe(false);
  });
  it.skipIf(!existsSync("plugin/node/check-plan.mjs"))("ships as an agent-run CLI with upstream exit codes", () => {
    const run = (args: string[]) => spawnSync(process.execPath, ["plugin/node/check-plan.mjs", ...args], { encoding: "utf8" });
    expect(run([]).status).toBe(2);
    mkdirSync("_tmp/test-runs", { recursive: true });
    writeFileSync("_tmp/test-runs/plan-cli.md", "# x\n");
    expect(run(["_tmp/test-runs/plan-cli.md"]).status).toBe(1);
  });
  it.skipIf(!existsSync("plugin/node/orch.mjs"))("orch ships as an agent-run CLI", () => {
    const r = spawnSync(process.execPath, ["plugin/node/orch.mjs", "--help"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("inbox");
  });
  it("is served over RPC as plan/check", async () => {
    const out: any = await dispatch("plan/check", { text: "# x\n", path: "x.md" });
    expect(out.result.ok).toBe(false);
  });
});

describe("orch RPC", () => {
  it("runs store ops and rejects unknown ones", async () => {
    const { mkdtempSync, rmSync, mkdirSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    mkdirSync("_tmp/test-runs", { recursive: true });
    const dir = mkdtempSync(resolve("_tmp/test-runs/orch-"));
    try {
      expect((await dispatch("orch/run", { store: dir, op: "init" })).error).toBeUndefined();
      const add: any = await dispatch("orch/run", { store: dir, op: "units.add", args: { id: "u1", track: "main", brief: "first" } });
      expect(add.error).toBeUndefined();
      const counts: any = await dispatch("orch/run", { store: dir, op: "units.counts" });
      expect(Object.values(counts.result).reduce((a: number, b: any) => a + b, 0)).toBeGreaterThanOrEqual(1);
      expect((await dispatch("orch/run", { store: dir, op: "merge" })).error?.message).toMatch(/^INVALID_INPUT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
