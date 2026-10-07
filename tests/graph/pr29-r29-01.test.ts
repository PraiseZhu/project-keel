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

describe("R29-01 entry Astra accepted", () => {
  it("accepts, runs, and finals astra-consult without INVALID_INPUT", async () => {
    const h = hostIO();
    const start = await call(h, "keel_run", { goal: "重构登录功能", repo_dir: "/repo", lead: "claude-code", scope: ["src/**"] });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    const started = start.result as { run_id: string; next: { kind: string; dispatch_key?: string } };
    expect(started.next.kind).toBe("dispatch");
    expect(started.next.dispatch_key).toContain(":astra-consult:");
    const accepted = await call(h, "keel_report", {
      run_id: started.run_id,
      phase: "accepted",
      dispatch_key: started.next.dispatch_key,
      worker_id: "architect-one",
      worker_session_id: "a-session",
      dispatch_outcome: { dispatched: true, wakeKind: "immediate" },
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    const acc = accepted.result as { next: { kind: string } };
    expect(acc.next.kind).toBe("wait");
    const st = JSON.parse(h.files.get(graphStatePath(started.run_id))!) as { nodes: Record<string, { dispatch_state?: string }> };
    expect(st.nodes["astra-consult"]?.dispatch_state).toBe("running");
    const fin = await call(h, "keel_report", {
      run_id: started.run_id,
      phase: "final",
      dispatch_key: started.next.dispatch_key,
      inline_report: { status: "done", summary: "feature" },
    });
    expect(fin.ok).toBe(true);
  });
});
