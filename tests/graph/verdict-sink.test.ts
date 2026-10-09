import { describe, expect, it } from "vitest";
import { makeContext } from "../../src/main/context.ts";
import { confirmLedgerHead, orchStorePath, recordVerifierVerdict } from "../../src/main/graph/verdict-sink.ts";
import type { GraphRunState } from "../../src/main/graph/state.ts";
import type { GraphVerdict } from "../../src/main/graph/verdict.ts";
import { runDoneCheck } from "../../src/main/tools/keel.ts";
import { fakeHost } from "../helpers/fakeHost.ts";
import { LANE_PRESETS } from "../../src/shared/types.ts";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const verdict: GraphVerdict = {
  repo: "acme/solo",
  pr: 7,
  base_ref: "main",
  base_sha: BASE,
  head_sha: HEAD,
  patch_id: "pid-1",
  level: "unit-test-verified",
  surface: "unit-test",
  by_route: { agent: "pi", model: "gpt-6-luna", provider_id: "art-cindy" },
  by_family: "gpt",
};

const state = {
  run_id: "r-sink",
  task_type: "bug-fix",
  spec_id: "bug-fix",
  gh_repo: "acme/solo",
  repo: "acme/solo",
  pr: 7,
  worktree: "/repo/wt",
  sc: [{ id: "SC-1", text: "x" }],
  status: "running",
  nodes: {
    implement: {
      attempts: 1,
      planned_params: { writes: true },
      actual_route: { model: "grok-4.6" },
      last_report: { status: "done", sc_evidence: { "SC-1": true } },
    },
  },
  verdict: {
    head: HEAD,
    base_ref: "main",
    base_sha: BASE,
    patch_id: "pid-1",
    level: "unit-test-verified",
    surface: "unit-test",
    by_route: verdict.by_route,
    by_family: "gpt",
  },
} as unknown as GraphRunState;

function snapshot() {
  return {
    preset: "personal" as const,
    rule: LANE_PRESETS.personal,
    pr: { repo: "acme/solo", number: 7, url: "u", title: "t", state: "OPEN" as const, isDraft: false, headSha: HEAD, headRef: "f", baseRef: "main", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, labels: [] },
    decision: { kind: "ready" as const },
    checks: { failed: [], pending: [], passed: 1 },
    unresolvedThreads: 0,
    gate: { applies: false, required: [], passed: [], failing: [], pending: [], missing: [], ok: true, sources: [] },
    verification: { check: "agent-verify", state: "pass" as const },
    mergeReadyLabel: false,
    rendered: "x",
  };
}

function hostWithLedger(opts: { recordFail?: boolean; checkFail?: boolean; lane?: boolean } = {}) {
  const ledger = new Map<string, Record<string, unknown>>();
  const statuses: Record<string, unknown>[] = [];
  const profile = {
    lanes: opts.lane ? [{ repo: "acme/solo", preset: "personal" as const, verifyCheck: "agent-verify" }] : [],
    routingPath: null,
    boardRepos: [],
    plansDir: null,
  };
  const h = fakeHost({
    node: (method: string, params: any) => {
      if (method === "pr/snapshot") return { ok: true, result: snapshot() };
      if (method === "pr/threads") return { ok: true, result: { threads: [] } };
      if (method === "git/state") return { ok: true, result: { head: HEAD } };
      if (method === "git/base-sha") return { ok: true, result: { base_ref: "main", base_sha: BASE } };
      if (method === "git/patch-id") return { ok: true, result: { ok: true, patch_id: "pid-1" } };
      if (method === "gh/commit-status") {
        statuses.push(params);
        return { ok: true, result: { ok: true, ...params } };
      }
      if (method === "orch/run") {
        if (params.op === "init") return { ok: true, result: { store: params.store } };
        if (params.op === "ledger.record") {
          if (opts.recordFail) return { ok: false, message: "ORCH_ERROR: disk full" };
          const args = params.args as Record<string, unknown>;
          ledger.set(`${args.pr}:${args.sha}`, args);
          return { ok: true, result: args };
        }
        if (params.op === "ledger.check") {
          if (opts.checkFail) return { ok: false, message: "NOT_FOUND: NOT-VERIFIED" };
          const args = params.args as Record<string, unknown>;
          const row = ledger.get(`${args.pr}:${args.sha}`);
          if (!row) return { ok: false, message: "NOT_FOUND: NOT-VERIFIED" };
          return { ok: true, result: row };
        }
        return { ok: false, message: `unknown orch ${params.op}` };
      }
      return { ok: false, message: method };
    },
  });
  return { h, ledger, statuses, profile };
}

describe("verdict-sink", () => {
  it("records the verifier verdict into orch ledger keyed by PR+SHA", async () => {
    const { h, ledger, profile } = hostWithLedger();
    const ctx = makeContext(h, "c1", profile);
    expect(orchStorePath(state)).toBe("/repo/wt/.keel/orch");
    const rec = await recordVerifierVerdict(ctx, state, verdict);
    expect(rec).toEqual({ ok: true });
    expect(ledger.get("7:" + HEAD)).toMatchObject({
      pr: 7,
      sha: HEAD,
      verdict: "unit-test-verified",
      verifier: "gpt-6-luna",
    });
    const chk = await confirmLedgerHead(ctx, state, HEAD);
    expect(chk).toEqual({ ok: true, missing: [] });
  });

  it("does not treat a change graph as done when ledger write/check fails", async () => {
    const { h, profile } = hostWithLedger({ recordFail: true, checkFail: true });
    const ctx = makeContext(h, "c1", profile);
    const rec = await recordVerifierVerdict(ctx, state, verdict);
    expect(rec.ok).toBe(false);
    expect(rec.message).toMatch(/ledger 写入失败/);
    const done = await runDoneCheck(ctx, structuredClone(state));
    expect(done.ok).toBe(false);
    const missing = (done as { next?: { context?: { missing?: string[] } } }).next?.context?.missing ?? [];
    expect(missing.some((m) => /ledger/.test(m))).toBe(true);
  });

  it("writes the lane verifyCheck commit status when the lane has one", async () => {
    const { h, statuses, profile } = hostWithLedger({ lane: true });
    const rec = await recordVerifierVerdict(makeContext(h, "c1", profile), state, verdict);
    expect(rec.ok).toBe(true);
    expect(statuses).toEqual([
      expect.objectContaining({
        repo: "acme/solo",
        sha: HEAD,
        state: "success",
        context: "agent-verify",
        description: "gpt-6-luna unit-test-verified",
      }),
    ]);
  });
});
