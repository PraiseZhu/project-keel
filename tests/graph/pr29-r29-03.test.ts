import { afterEach, describe, expect, it } from "vitest";
import { makeWorld, makeE2eHost, startRun, leadLoop, cleanupRepos } from "../e2e/helpers.ts";
import { LANE_PRESETS } from "../../src/shared/types.ts";
import { mapChangeDoneFailure } from "../../src/main/tools/keel.ts";
import type { GraphRunState } from "../../src/main/graph/state.ts";

afterEach(cleanupRepos);

describe("R29-03 premature pr_ready", () => {
  it("does not emit pr_ready when handoff is not the only missing item", () => {
    const next = mapChangeDoneFailure(
      { run_id: "r1" } as GraphRunState,
      {
        done: false,
        missing: ["pr_status 是 handoff，不是可合并/已交接/已关闭", "SC SC-MISSING 没有证据"],
        next: "wait",
      },
    );
    expect(next.kind).toBe("decide");
    if (next.kind === "decide") expect(next.question).toMatch(/SC-MISSING/);
  });

  it("gated-handoff with a missing SC does not give pr_ready", async () => {
    const world = makeWorld();
    const h = makeE2eHost(world);
    const original = h.node.bind(h);
    h.node = async (method, params, options) => {
      const out = await original(method, params, options);
      if (method === "pr/snapshot" && out.ok) {
        return {
          ok: true as const,
          result: {
            ...(out.result as object),
            preset: "gated-handoff",
            rule: LANE_PRESETS["gated-handoff"],
            gate: { applies: true, required: ["verify"], passed: ["verify"], failing: [], pending: [], missing: [], ok: true, sources: ["test"] },
          },
        };
      }
      return out;
    };
    const start = await startRun(h, {
      goal: "修登录报错",
      repo_dir: world.repoDir,
      lead: "codex",
      playbook: "bug-fix",
      scope: ["src/**"],
      sc: [{ id: "SC-MISSING", text: "必须有证据" }],
    });
    const before = await leadLoop(h, start, world, {
      stopWhen: (next) =>
        (next.kind === "wait" && next.call.tool === "pr_ready") ||
        (next.kind === "decide" && next.gate_id === "done") ||
        next.kind === "done",
    });
    expect(before.next.kind).not.toBe("wait");
    if (before.next.kind === "wait") expect(before.next.call.tool).not.toBe("pr_ready");
    expect(before.next.kind).toBe("decide");
    if (before.next.kind === "decide") expect(before.next.question).toMatch(/SC-MISSING/);
  });
});
