import { describe, expect, it } from "vitest";
import { isChangeGraphDone } from "../../src/main/graph/done.ts";
import { advance, createRun } from "../../src/main/graph/interpreter.ts";
import { PLANNED_TIMEOUT_MS, type GraphRunState } from "../../src/main/graph/state.ts";
import { authorFamiliesFromRoutes } from "../../src/main/tools/keel.ts";
import { cloneManual, DEFAULT_MANUAL } from "../../src/shared/manual/schema.ts";
import { fakeHost } from "../helpers/fakeHost.ts";

describe("SC-7 cumulative author families", () => {
  it("keeps attempt-1 family after a write node retries with another family, so a same-family verifier cannot done", () => {
    const state = {
      author_families: ["grok"],
      nodes: {
        implement: {
          status: "succeeded",
          attempts: 2,
          planned_params: {
            writes: true,
            role: "keel-worker",
            agent: "pi",
            model: "gpt-6-luna",
            provider_id: "art-cindy",
            label: "keel-w",
            initial_task: "x",
            fallbacks: [],
            route_index: 1,
          },
          actual_route: { agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy" },
          attempt_families: ["grok", "gpt"],
        },
      },
    } as unknown as GraphRunState;
    const families = authorFamiliesFromRoutes(state);
    expect(families).toEqual(expect.arrayContaining(["grok", "gpt"]));
    const result = isChangeGraphDone({
      pr_status: "report_mergeable",
      author_families: families,
      verdict: {
        repo: "acme/app",
        pr: 1,
        base_ref: "main",
        base_sha: "base",
        head_sha: "head",
        patch_id: "pid",
        level: "unit-test-verified",
        surface: "unit-test",
        by_route: { agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy" },
        by_family: "grok",
      },
      current: { head_sha: "head", base_sha: "base", patch_id: "pid", patch_ok: true },
      sc: [{ id: "SC-1", hasEvidence: true }],
      openHumanGates: 0,
    });
    expect(result.done).toBe(false);
    expect(result.missing.join("；")).toMatch(/作者族/);
  });
});

const H = "a".repeat(40), B = "b".repeat(40);

describe("R30-01 reconcile-only write attempts still register author families", () => {
  it.each(["running", "idle"])("omitted accepted then reconcile %s cannot let a same-family verifier done", async (status) => {
    const manual = cloneManual(DEFAULT_MANUAL);
    const h = fakeHost({
      kv: { manual },
      node: (method) => method === "git/state"
        ? { ok: true, result: { head: H, root: "/repo", branch: "feature", gh_repo: "o/r" } }
        : { ok: false, message: method },
    });
    await createRun(h, {
      run_id: "run-author", spec_id: "bug-fix", profile_id: "sol", lead_harness: "codex",
      task_type: "bug-fix", entry: "reproduce", goal: "fix", worktree: "/repo/.worktrees/one",
      scopeAllow: ["src/**"], now: h.now(),
    });
    const opts = {
      gates: { advance: () => "advance" as const, accept: () => "adopt" as const },
      config: { manual, lanes: [], limits: { concurrentRuns: 4, inFlightNodesPerRun: 3, astraBudget: 4 }, thresholds: { act: 0.75, strict: 0.8 } },
    };
    const tick = () => advance(h, "run-author", { type: "tick" }, opts);
    const accepted = (key: string) => advance(h, "run-author", {
      type: "report", phase: "accepted", dispatch_key: key, worker_id: "w", worker_session_id: "ws",
      dispatch_outcome: { created: true, delivered: true },
    }, opts);
    const final = (key: string) => advance(h, "run-author", { type: "report", phase: "final", dispatch_key: key, inline_report: { status: "done" } }, opts);
    const first = await tick(); expect(first.next.kind).toBe("setup");
    let out = await advance(h, "run-author", { type: "report", phase: "setup", outcome: { worker_permission_mode: "bypassPermissions", team_id: "team" } }, opts);
    if (out.next.kind !== "dispatch") throw new Error("reproduce dispatch");
    const repro = out.next.dispatch_key;
    await accepted(repro); out = await final(repro);
    expect(out.state.author_families).toEqual(["grok"]);
    if (out.next.kind !== "dispatch") throw new Error("explore dispatch");
    const explore = out.next.dispatch_key; await accepted(explore); out = await final(explore);
    if (out.next.kind !== "dispatch") throw new Error("research create");
    const research = out.next.dispatch_key;
    await accepted(research);
    out = await final(research);
    (manual.profiles[0]!.nodes.default as { worker: unknown }).worker = { primary: { agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy", effort: "high" } };
    out = await final(research);
    if (out.state.cursor === "architect-plan") {
      if (out.next.kind !== "dispatch") throw new Error("architect dispatch");
      const arch = out.next.dispatch_key;
      await accepted(arch);
      out = await final(arch);
    }
    expect(out.state.cursor).toBe("implement");
    if (out.next.kind !== "dispatch") throw new Error("implement dispatch");
    const impl = out.next.dispatch_key;
    expect(out.next.create_worker!.model).toBe("gpt-6-luna");
    h.clock.t += PLANNED_TIMEOUT_MS;
    out = await tick(); expect(out.next.kind).toBe("reconcile");
    out = await advance(h, "run-author", {
      type: "report", phase: "reconcile", dispatch_key: impl,
      queries_result: { list_workers: { ok: true, complete: true, team_id: "team", workers: [{ label: out.state.nodes.implement.worker_label!, worker_id: "wi", worker_session_id: "wsi", status }] } },
    }, opts);
    expect(out.state.nodes.implement.dispatch_state).toBe(status === "running" ? "running" : "accepted");
    out = await final(impl);
    const families = authorFamiliesFromRoutes(out.state);
    expect(families).toEqual(expect.arrayContaining(["grok", "gpt"]));
    const done = isChangeGraphDone({
      pr_status: "report_mergeable",
      author_families: families,
      verdict: {
        repo: "o/r", pr: 1, base_ref: "main", base_sha: B, head_sha: H, patch_id: "patch",
        level: "unit-test-verified", surface: "unit-test",
        by_route: { agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy" }, by_family: "gpt",
      },
      current: { head_sha: H, base_sha: B, patch_id: "patch", patch_ok: true },
      sc: [{ id: "SC-1", hasEvidence: true }],
      openHumanGates: 0,
    });
    expect(done.done).toBe(false);
    expect(done.missing.join("；")).toMatch(/作者族/);
  });
});
