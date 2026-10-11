import { describe, expect, it } from "vitest";
import { makeContext } from "../../src/main/context.ts";
import { runTool } from "../../src/main/dispatch.ts";
import { graphStatePath } from "../../src/main/store/runs.ts";
import { fakeHost, typesafeAnswering } from "../helpers/fakeHost.ts";

const H = "a".repeat(40);

function host() {
  return fakeHost({
    fetch: typesafeAnswering(0.2),
    node: (method) => {
      if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "feat/x", head: H, gh_repo: "o/r" } };
      if (method === "git/content-fingerprint") return { ok: true, result: { head: H, content_hash: "h", status_digest: "s" } };
      if (method === "worktree/create") return { ok: true, result: { path: "/repo/.worktrees/probe" } };
      return { ok: false, message: "unexpected " + method };
    },
  });
}

async function call(h: ReturnType<typeof host>, tool: string, args: Record<string, unknown>) {
  return runTool(makeContext(h, tool), tool, args);
}

/** Entry routing goes to the lead now; the first dispatch after the answer still needs the team. */
async function routed(h: ReturnType<typeof host>) {
  const start = await call(h, "keel_run", { goal: "重构登录功能", repo_dir: "/repo", lead: "claude-code", scope: ["src/**"] });
  expect(start.ok).toBe(true);
  if (!start.ok) throw new Error("keel_run");
  const started = start.result as { run_id: string; next: { kind: string; gate_id?: string } };
  expect(started.next.kind).toBe("decide");
  expect(started.next.gate_id).toBe("G-route");
  const gated = await call(h, "keel_gate", { run_id: started.run_id, gate_id: "G-route", answer: "refactoring" });
  expect(gated.ok).toBe(true);
  if (!gated.ok) throw new Error("keel_gate");
  return { run_id: started.run_id, next: (gated.result as { next: { kind: string } }).next };
}

describe("R29-R01 entry team setup", () => {
  it("has no team: setup then first dispatch then accepted; NOT_FOUND returns setup", async () => {
    const h = host();
    const started = await routed(h);
    expect(started.next.kind).toBe("setup");
    const afterSetup = await call(h, "keel_report", {
      run_id: started.run_id,
      phase: "setup",
      outcome: { worker_permission_mode: "bypassPermissions", team_id: "t1" },
    });
    expect(afterSetup.ok).toBe(true);
    if (!afterSetup.ok) return;
    const dispatched = afterSetup.result as { next: { kind: string; dispatch_key?: string; create_worker?: { role?: string } } };
    expect(dispatched.next.kind).toBe("dispatch");
    expect(dispatched.next.dispatch_key).toContain(":implement:");
    const st = JSON.parse(h.files.get(graphStatePath(started.run_id))!) as { nodes: Record<string, { team_id?: string }> };
    expect(st.nodes.implement?.team_id).toBe("t1");
    const accepted = await call(h, "keel_report", {
      run_id: started.run_id,
      phase: "accepted",
      dispatch_key: dispatched.next.dispatch_key,
      worker_id: "writer",
      worker_session_id: "ws",
      dispatch_outcome: { dispatched: true, wakeKind: "immediate" },
    });
    expect(accepted.ok).toBe(true);

    const h2 = host();
    const s2 = await routed(h2);
    const setup2 = await call(h2, "keel_report", {
      run_id: s2.run_id,
      phase: "setup",
      outcome: { worker_permission_mode: "bypassPermissions", team_id: "t1" },
    });
    if (!setup2.ok) return;
    const d2 = setup2.result as { next: { kind: string; dispatch_key?: string } };
    const missing = await call(h2, "keel_report", {
      run_id: s2.run_id,
      phase: "accepted",
      dispatch_key: d2.next.dispatch_key,
      dispatch_outcome: { errorCode: "NOT_FOUND", dispatched: false },
    });
    expect(missing.ok).toBe(true);
    if (!missing.ok) return;
    expect((missing.result as { next: { kind: string } }).next.kind).toBe("setup");
  });
});
