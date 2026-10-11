import { describe, expect, it } from "vitest";
import { makeContext } from "../../src/main/context.ts";
import { runTool } from "../../src/main/dispatch.ts";
import { graphStatePath } from "../../src/main/store/runs.ts";
import { cloneManual, DEFAULT_MANUAL } from "../../src/shared/manual/schema.ts";
import { fakeHost, typesafeAnswering } from "../helpers/fakeHost.ts";

const profile = { lanes: [], routingPath: null, boardRepos: [], plansDir: null };

function nodeOk(method: string) {
  if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "main", head: "a".repeat(40), gh_repo: "acme/app" } };
  if (method === "git/content-fingerprint") return { ok: true, result: { head: "a".repeat(40), status_digest: "d", content_hash: "h" } };
  if (method === "worktree/create") return { ok: true, result: { path: "/repo/.worktrees/keel-x" } };
  return { ok: false, message: method };
}

function astraGateManual() {
  const manual = cloneManual(DEFAULT_MANUAL);
  const grok = manual.profiles.find((p) => p.id === "grok")!;
  (grok as { direction_gate: string }).direction_gate = "astra";
  return manual;
}

describe("G-route entry with direction_gate=astra", () => {
  it("asks the lead instead of consulting Architect, and spends no astra budget", async () => {
    const h = fakeHost({ kv: { manual: astraGateManual() }, fetch: typesafeAnswering(0.2), node: nodeOk });
    const started = await runTool(makeContext(h, "c1", profile), "keel_run", {
      goal: "重构登录功能",
      repo_dir: "/repo",
      scope: ["src/**"],
      lead: "claude-code",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const result = started.result as { run_id: string; next: { kind: string; gate_id?: string; options?: string[] } };
    expect(result.next.kind).toBe("decide");
    expect(result.next.gate_id).toBe("G-route");
    expect(result.next.options).toEqual(expect.arrayContaining(["refactoring", "feature"]));
    expect(h.nodeCalls.some((c) => c.method === "worktree/create")).toBe(false);
    const gated = await runTool(makeContext(h, "c2", profile), "keel_gate", {
      run_id: result.run_id,
      gate_id: "G-route",
      answer: "refactoring",
    });
    expect(gated.ok).toBe(true);
    if (!gated.ok) return;
    expect((gated.result as { next: { kind: string } }).next.kind).not.toBe("decide");
    const st = JSON.parse(h.files.get(graphStatePath(result.run_id))!);
    expect(st.spec_id).toBe("refactoring");
    expect(st.astra_calls ?? 0).toBe(0);
    expect(st.consult_node).toBeUndefined();
    expect(st.nodes["astra-consult"]).toBeUndefined();
  });
});
