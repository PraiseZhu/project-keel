import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeContext } from "../../src/main/context.ts";
import { runTool } from "../../src/main/dispatch.ts";
import { graphStatePath } from "../../src/main/store/runs.ts";
import type { GraphRunState } from "../../src/main/graph/state.ts";
import { LANE_PRESETS } from "../../src/shared/types.ts";
import { ToolError } from "../../src/node/env.ts";
import { runOrch } from "../../src/node/orch/rpc.ts";
import { fakeHost } from "../helpers/fakeHost.ts";

const profile = { lanes: [], routingPath: null, boardRepos: [], plansDir: null };
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const HEAD = "a".repeat(40);

function snapshot(pr: number, kind: "green" | "red" | "waiting") {
  const failed = kind === "red" ? ["ci"] : [];
  const pending = kind === "waiting" ? ["ci"] : [];
  return {
    preset: "personal",
    rule: LANE_PRESETS.personal,
    pr: {
      repo: "o/r", number: pr, url: `https://github.com/o/r/pull/${pr}`, title: "t", state: "OPEN",
      isDraft: false, headSha: HEAD, headRef: "feat/x", baseRef: "main",
      mergeable: kind === "green" ? "MERGEABLE" : "UNSTABLE",
      mergeStateStatus: kind === "green" ? "CLEAN" : "UNSTABLE",
      reviewDecision: null, labels: [],
    },
    decision: kind === "green" ? { kind: "ready" } : kind === "red" ? { kind: "blocker", blocker: "failing-checks" } : { kind: "waiting" },
    checks: { failed, pending, passed: kind === "green" ? 1 : 0 },
    unresolvedThreads: 0,
    gate: { applies: false, required: [], passed: [], failing: [], pending: [], missing: [], ok: true, sources: [] },
    verification: null,
    mergeReadyLabel: false,
  };
}

function host(ci: Record<number, "green" | "red" | "waiting">) {
  return fakeHost({
    node: async (method, params: Record<string, unknown>) => {
      if (method === "orch/run") {
        try {
          const result = await runOrch({
            store: String(params.store),
            op: String(params.op),
            args: params.args,
            force: Boolean(params.force),
          });
          return { ok: true, result };
        } catch (e) {
          const code = e instanceof ToolError ? e.code : "ORCH_ERROR";
          return { ok: false, message: `${code}: ${e instanceof Error ? e.message : String(e)}` };
        }
      }
      if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "feat/x", head: HEAD, gh_repo: "o/r" } };
      if (method === "pr/snapshot") {
        const pr = Number(params.pr);
        return { ok: true, result: snapshot(pr, ci[pr] ?? "waiting") };
      }
      if (method === "pr/threads") return { ok: true, result: { threads: [] } };
      return { ok: false, message: "UNEXPECTED " + method };
    },
  });
}

const base = { goal: "program", repo_dir: "/repo", lead: "codex" as const };

describe("Step 13 / R30 keel_run.program", () => {
  it("R30-02: CI green advances past wait-ci; CI red takes its own fail path", async () => {
    const store = mkdtempSync(join(tmpdir(), "keel-program-"));
    dirs.push(store);
    const h = host({ 1: "red", 2: "green" });
    const ctx = () => makeContext(h, "p", profile);
    expect((await runTool(ctx(), "keel_run", { ...base, program: { op: "init", store } })).ok).toBe(true);
    expect((await runTool(ctx(), "keel_run", { ...base, program: { op: "add", store, id: "bad", track: "t", pr: 1 } })).ok).toBe(true);
    expect((await runTool(ctx(), "keel_run", { ...base, program: { op: "add", store, id: "ok", track: "t", pr: 2 } })).ok).toBe(true);
    const tick = await runTool(ctx(), "keel_run", { ...base, program: { op: "tick", store } });
    expect(tick.ok).toBe(true);
    if (!tick.ok) return;
    const result = tick.result as { started: string[]; runs?: { unit_id: string; run_id: string; next?: { kind: string } }[] };
    expect(result.started.sort()).toEqual(["bad", "ok"]);
    expect(h.nodeCalls.some((c) => c.method === "pr/snapshot")).toBe(true);
    const runs = result.runs ?? [];
    const byUnit = Object.fromEntries(runs.map((r) => [r.unit_id, r]));
    const okState = JSON.parse(h.files.get(graphStatePath(byUnit.ok!.run_id))!) as GraphRunState;
    const badState = JSON.parse(h.files.get(graphStatePath(byUnit.bad!.run_id))!) as GraphRunState;
    expect(okState.cursor).not.toBe("wait-ci");
    expect(okState.invocation_dir).toBe("/repo");
    expect(badState.cursor).toBe("ci-rerun-once");
    expect(okState.run_id).not.toBe(badState.run_id);
    expect(result.runs?.some((r) => r.next)).toBe(true);
  });

  it("R30-03: same unit id in two stores does not overwrite the other graph; restore keeps each run_id", async () => {
    const a = mkdtempSync(join(tmpdir(), "keel-program-a-"));
    const b = mkdtempSync(join(tmpdir(), "keel-program-b-"));
    dirs.push(a, b);
    const h = host({ 1: "waiting", 2: "waiting" });
    const ctx = () => makeContext(h, "p", profile);
    for (const store of [a, b]) expect((await runTool(ctx(), "keel_run", { ...base, program: { op: "init", store } })).ok).toBe(true);
    expect((await runTool(ctx(), "keel_run", { ...base, program: { op: "add", store: a, id: "release", track: "a", pr: 1 } })).ok).toBe(true);
    const tickA = await runTool(ctx(), "keel_run", { ...base, program: { op: "tick", store: a } });
    expect(tickA.ok).toBe(true);
    if (!tickA.ok) return;
    const runA = (tickA.result as { runs: { unit_id: string; run_id: string }[] }).runs.find((r) => r.unit_id === "release")!.run_id;
    expect((await runTool(ctx(), "keel_run", { ...base, program: { op: "add", store: b, id: "release", track: "b", pr: 2 } })).ok).toBe(true);
    const tickB = await runTool(ctx(), "keel_run", { ...base, program: { op: "tick", store: b } });
    expect(tickB.ok).toBe(true);
    if (!tickB.ok) return;
    const runB = (tickB.result as { runs: { unit_id: string; run_id: string }[] }).runs.find((r) => r.unit_id === "release")!.run_id;
    expect(runA).not.toBe(runB);
    expect((JSON.parse(h.files.get(graphStatePath(runA))!) as GraphRunState).pr).toBe(1);
    expect((JSON.parse(h.files.get(graphStatePath(runB))!) as GraphRunState).pr).toBe(2);
    const restoreA = await runTool(ctx(), "keel_run", { ...base, program: { op: "restore", store: a } });
    const restoreB = await runTool(ctx(), "keel_run", { ...base, program: { op: "restore", store: b } });
    expect(restoreA.ok && restoreB.ok).toBe(true);
    if (!restoreA.ok || !restoreB.ok) return;
    const unitA = (restoreA.result as { units: { id: string; pr: string; branch: string }[] }).units[0]!;
    const unitB = (restoreB.result as { units: { id: string; pr: string; branch: string }[] }).units[0]!;
    expect(unitA).toMatchObject({ id: "release", pr: "1", branch: runA });
    expect(unitB).toMatchObject({ id: "release", pr: "2", branch: runB });
    await runTool(ctx(), "keel_run", { ...base, program: { op: "tick", store: a } });
    expect((JSON.parse(h.files.get(graphStatePath(runA))!) as GraphRunState).pr).toBe(1);
    expect((JSON.parse(h.files.get(graphStatePath(runB))!) as GraphRunState).pr).toBe(2);
  });
});
