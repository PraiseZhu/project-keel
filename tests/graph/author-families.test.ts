import { describe, expect, it } from "vitest";
import { isChangeGraphDone } from "../../src/main/graph/done.ts";
import type { GraphRunState } from "../../src/main/graph/state.ts";
import { authorFamiliesFromRoutes } from "../../src/main/tools/keel.ts";

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
