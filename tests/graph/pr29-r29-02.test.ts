import { describe, expect, it } from "vitest";
import { makeContext } from "../../src/main/context.ts";
import { runTool } from "../../src/main/dispatch.ts";
import { graphStatePath } from "../../src/main/store/runs.ts";
import { fakeHost, typesafeAnswering } from "../helpers/fakeHost.ts";

const H = "a".repeat(40);

function hostIO() {
  return fakeHost({
    fetch: typesafeAnswering(0.2),
    node: (method) => {
      if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "feat/x", head: H, gh_repo: "o/r" } };
      if (method === "git/content-fingerprint") return { ok: true, result: { head: H, content_hash: "h", status_digest: "s" } };
      if (method === "worktree/create") return { ok: true, result: { path: "/repo/.worktrees/new" } };
      if (method === "git/changed-files") return { ok: true, result: { files: [] } };
      return { ok: false, message: "unexpected " + method };
    },
  });
}

async function call(h: ReturnType<typeof fakeHost>, tool: string, args: Record<string, unknown>) {
  return runTool(makeContext(h, tool), tool, args);
}

describe("R29-02 Astra rematerialize", () => {
  it("clears g_route_choice and dispatches explore after Astra picks feature", async () => {
    const h = hostIO();
    const start = await call(h, "keel_run", { goal: "重构登录功能", repo_dir: "/repo", lead: "claude-code", scope: ["src/**"] });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    const started = start.result as { run_id: string; next: { kind: string; dispatch_key?: string } };
    await call(h, "keel_report", {
      run_id: started.run_id,
      phase: "accepted",
      dispatch_key: started.next.dispatch_key,
      worker_id: "architect-one",
      worker_session_id: "a-session",
      dispatch_outcome: { dispatched: true, wakeKind: "immediate" },
    });
    const fin = await call(h, "keel_report", {
      run_id: started.run_id,
      phase: "final",
      dispatch_key: started.next.dispatch_key,
      inline_report: { status: "done", summary: "feature" },
    });
    expect(fin.ok).toBe(true);
    if (!fin.ok) return;
    const after = fin.result as { next: { kind: string } };
    const setup = after.next.kind === "setup"
      ? await call(h, "keel_report", {
          run_id: started.run_id,
          phase: "setup",
          outcome: { worker_permission_mode: "bypassPermissions", team_id: "t1" },
        })
      : fin;
    expect(setup.ok).toBe(true);
    if (!setup.ok) return;
    const next = (setup.result as { next: { kind: string; dispatch_key?: string; create_worker?: { role?: string } } }).next;
    expect(next.kind).toBe("dispatch");
    expect(next.dispatch_key).toContain(":explore:");
    const s = JSON.parse(h.files.get(graphStatePath(started.run_id))!) as {
      g_route_choice?: string;
      consult_node?: unknown;
      cursor: string;
      astra_calls: number;
      spec_id: string;
    };
    expect(s.g_route_choice).toBeUndefined();
    expect(s.consult_node).toBeUndefined();
    expect(s.spec_id).toBe("feature");
    expect(s.cursor).toBe("explore");
    expect(s.astra_calls).toBeGreaterThan(0);
  });
});
