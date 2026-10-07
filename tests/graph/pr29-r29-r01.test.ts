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

describe("R29-R01 entry consult team setup", () => {
  it("has no team: setup then consult dispatch then accepted; NOT_FOUND returns setup", async () => {
    const h = host();
    const start = await call(h, "keel_run", { goal: "重构登录功能", repo_dir: "/repo", lead: "claude-code", scope: ["src/**"] });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    const started = start.result as { run_id: string; next: { kind: string; dispatch_key?: string } };
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
    expect(dispatched.next.dispatch_key).toContain(":astra-consult:");
    const st = JSON.parse(h.files.get(graphStatePath(started.run_id))!) as { nodes: Record<string, { team_id?: string }> };
    expect(st.nodes["astra-consult"]?.team_id).toBe("t1");
    const accepted = await call(h, "keel_report", {
      run_id: started.run_id,
      phase: "accepted",
      dispatch_key: dispatched.next.dispatch_key,
      worker_id: "arch",
      worker_session_id: "as",
      dispatch_outcome: { dispatched: true, wakeKind: "immediate" },
    });
    expect(accepted.ok).toBe(true);

    const h2 = host();
    const start2 = await call(h2, "keel_run", { goal: "重构登录功能", repo_dir: "/repo", lead: "claude-code", scope: ["src/**"] });
    if (!start2.ok) return;
    const s2 = start2.result as { run_id: string; next: { kind: string } };
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
