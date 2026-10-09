import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeContext } from "../../src/main/context.ts";
import { runTool } from "../../src/main/dispatch.ts";
import { fakeHost, typesafeAnswering } from "../helpers/fakeHost.ts";

const H = "a".repeat(40);

function hostIO() {
  return fakeHost({
    fetch: typesafeAnswering(0.9),
    node: (method) => {
      if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "feat/x", head: H, gh_repo: "o/r" } };
      if (method === "worktree/create") return { ok: true, result: { path: "/repo/.worktrees/new" } };
      if (method === "git/changed-files") return { ok: true, result: { files: [] } };
      return { ok: false, message: "unexpected " + method };
    },
  });
}

describe("§4.13 session_context", () => {
  it("declares sessionContext and reads session_id from args.session_context", () => {
    const index = readFileSync("src/main/index.ts", "utf8");
    const manifest = JSON.parse(readFileSync("plugin/ghost.json", "utf8")) as { sessionContext?: unknown };
    expect(index).toMatch(/args\.session_context/);
    expect(index).not.toMatch(/msg\.session_context\?\.session_id/);
    expect(manifest.sessionContext).toBe(true);
  });

  it("invalidates team_ready when the host injects a different session_id in args.session_context", async () => {
    const h = hostIO();
    const start = await runTool(makeContext(h, "s", undefined, undefined, "session-a"), "keel_run", {
      goal: "修登录报错",
      repo_dir: "/repo",
      lead: "codex",
      scope: ["src/**"],
    });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    const runId = (start.result as { run_id: string }).run_id;
    await runTool(makeContext(h, "setup", undefined, undefined, "session-a"), "keel_report", {
      run_id: runId,
      phase: "setup",
      outcome: { worker_permission_mode: "bypassPermissions", team_id: "t1" },
      get_workspace_info: { workflow: { workflow_id: "t1", lead_session_id: "session-a" } },
    });
    const hostArgs = { session_context: { session_id: "session-b", workdir: "/repo", workdir_is_local: true, workdir_is_read_only: false } };
    const sessionId = typeof hostArgs.session_context.session_id === "string" ? hostArgs.session_context.session_id : undefined;
    const moved = await runTool(makeContext(h, "wait", undefined, undefined, sessionId), "keel_wait", { run_id: runId });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect((moved.result as { next: { kind: string } }).next.kind).toBe("setup");
  });
});
