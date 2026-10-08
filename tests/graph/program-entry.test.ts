import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeContext } from "../../src/main/context.ts";
import { runTool } from "../../src/main/dispatch.ts";
import { graphStatePath, withRun } from "../../src/main/store/runs.ts";
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

function host(ci: Record<number, "green" | "red" | "waiting">, extra?: { patch?: boolean; ledger?: boolean }) {
  const kinds = { ...ci };
  const h = fakeHost({
    node: async (method, params: Record<string, unknown>) => {
      if (method === "orch/run") {
        try {
          const storePath = String(params.store ?? "");
          if (storePath.endsWith(".keel/orch")) {
            if (String(params.op) === "init") return { ok: true, result: {} };
            if (String(params.op) === "ledger.check") return extra?.ledger ? { ok: true, result: { sha: HEAD } } : { ok: true, result: undefined };
          }
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
      if (method === "git/base-sha") return { ok: true, result: { base_sha: "b".repeat(40), base_ref: "main" } };
      if (method === "git/patch-id") return extra?.patch
        ? { ok: true, result: { ok: true, patch_id: "pid" } }
        : { ok: true, result: { ok: false } };
      if (method === "pr/snapshot") {
        const pr = Number(params.pr);
        return { ok: true, result: snapshot(pr, kinds[pr] ?? "waiting") };
      }
      if (method === "pr/threads") return { ok: true, result: { threads: [] } };
      return { ok: false, message: "UNEXPECTED " + method };
    },
  });
  return Object.assign(h, { setCi: (pr: number, kind: "green" | "red" | "waiting") => { kinds[pr] = kind; } });
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

  async function toReportReady(h: ReturnType<typeof host>, store: string, runId: string, next: { kind: string; dispatch_key?: string; gate_id?: string; options?: string[] }) {
    const ctx = () => makeContext(h, "p", profile);
    for (let i = 0; i < 12; i++) {
      const st = JSON.parse(h.files.get(graphStatePath(runId))!) as GraphRunState;
      if (st.cursor === "report-ready") return st;
      let out: Awaited<ReturnType<typeof runTool>>;
      if (next.kind === "setup") {
        out = await runTool(ctx(), "keel_report", { run_id: runId, phase: "setup", outcome: { worker_permission_mode: "bypassPermissions", team_id: "team" } });
      } else if (next.kind === "dispatch") {
        const key = next.dispatch_key;
        await runTool(ctx(), "keel_report", {
          run_id: runId, phase: "accepted", dispatch_key: key, worker_id: "w", worker_session_id: "ws",
          dispatch_outcome: { dispatched: true, wakeKind: "immediate" },
        });
        out = await runTool(ctx(), "keel_report", {
          run_id: runId, phase: "final", dispatch_key: key,
          inline_report: { status: "done", summary: "adopt", verdict: "PASS", head_sha: HEAD, files_changed: [], ran: [{ cmd: "vitest run", exit_code: 0, tests_passed: 1 }] },
        });
      } else if (next.kind === "decide") {
        const answer = next.options?.includes("adopt") ? "adopt" : next.options?.[0];
        out = await runTool(ctx(), "keel_gate", { run_id: runId, gate_id: next.gate_id, answer });
      } else {
        throw new Error("unexpected next " + JSON.stringify(next));
      }
      expect(out.ok, JSON.stringify(out)).toBe(true);
      if (!out.ok) return st;
      next = (out.result as { next: typeof next }).next;
    }
    throw new Error("did not reach report-ready");
  }

  it.each(["green", "red"] as const)("R30-R01: public path to report-ready does not done when final CI is %s and bindings/verdict are missing", async (finalCi) => {
    const store = mkdtempSync(join(tmpdir(), "keel-program-term-"));
    dirs.push(store);
    const h = host({ 7: "green" });
    const ctx = () => makeContext(h, "p", profile);
    expect((await runTool(ctx(), "keel_run", { ...base, program: { op: "init", store } })).ok).toBe(true);
    expect((await runTool(ctx(), "keel_run", { ...base, program: { op: "add", store, id: "terminal", track: "t", pr: 7 } })).ok).toBe(true);
    const begun = await runTool(ctx(), "keel_run", { ...base, program: { op: "tick", store } });
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    const row = (begun.result as { runs: { run_id: string; next: { kind: string; dispatch_key?: string; gate_id?: string; options?: string[] } }[] }).runs[0]!;
    await toReportReady(h, store, row.run_id, row.next);
    const before = JSON.parse(h.files.get(graphStatePath(row.run_id))!) as GraphRunState;
    expect(before.cursor).toBe("report-ready");
    expect(before.verdict).toBeUndefined();
    h.setCi(7, finalCi);
    const snapsBefore = h.nodeCalls.filter((c) => c.method === "pr/snapshot").length;
    const tick = await runTool(ctx(), "keel_run", { ...base, program: { op: "tick", store } });
    expect(tick.ok).toBe(true);
    if (!tick.ok) return;
    const after = JSON.parse(h.files.get(graphStatePath(row.run_id))!) as GraphRunState;
    expect(after.status).not.toBe("done");
    expect(after.cursor).not.toBe("done");
    const next = (tick.result as { runs: { next?: { kind: string } }[] }).runs[0]?.next;
    expect(next?.kind).not.toBe("done");
    expect(next?.kind === "decide" || next?.kind === "wait").toBe(true);
    if (finalCi === "red") {
      expect(h.nodeCalls.filter((c) => c.method === "pr/snapshot").length).toBeGreaterThan(snapsBefore);
      expect(after.cursor === "ci-rerun-once" || next?.kind === "decide").toBe(true);
    }
  });

  it("R30-R01: only a run with verdict, patch, ledger and author families can done", async () => {
    const store = mkdtempSync(join(tmpdir(), "keel-program-ok-"));
    dirs.push(store);
    const h = host({ 7: "green" }, { patch: true, ledger: true });
    const ctx = () => makeContext(h, "p", profile);
    expect((await runTool(ctx(), "keel_run", { ...base, program: { op: "init", store } })).ok).toBe(true);
    expect((await runTool(ctx(), "keel_run", { ...base, program: { op: "add", store, id: "ready", track: "t", pr: 7 } })).ok).toBe(true);
    const begun = await runTool(ctx(), "keel_run", { ...base, program: { op: "tick", store } });
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    const row = (begun.result as { runs: { run_id: string; next: { kind: string; dispatch_key?: string; gate_id?: string; options?: string[] } }[] }).runs[0]!;
    await toReportReady(h, store, row.run_id, row.next);
    await withRun(h, row.run_id, (raw) => {
      const s = raw as unknown as GraphRunState;
      s.author_families = ["grok"];
      s.verdict = {
        head: HEAD,
        base_ref: "main",
        base_sha: "b".repeat(40),
        patch_id: "pid",
        value: "unit-test-verified",
        level: "unit-test-verified",
        surface: "unit-test",
        by_route: { agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy" },
        by_family: "gpt",
      };
    });
    const tick = await runTool(ctx(), "keel_run", { ...base, program: { op: "tick", store } });
    expect(tick.ok).toBe(true);
    if (!tick.ok) return;
    const after = JSON.parse(h.files.get(graphStatePath(row.run_id))!) as GraphRunState;
    expect(after.status).toBe("done");
    expect((tick.result as { runs: { next?: { kind: string } }[] }).runs[0]?.next?.kind).toBe("done");
  });
});
