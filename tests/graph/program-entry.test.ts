import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeContext } from "../../src/main/context.ts";
import { runTool } from "../../src/main/dispatch.ts";
import { graphStatePath, withRun } from "../../src/main/store/runs.ts";
import type { GraphRunState } from "../../src/main/graph/state.ts";
import { ToolError } from "../../src/node/env.ts";
import { runOrch } from "../../src/node/orch/rpc.ts";
import { fakeHost } from "../helpers/fakeHost.ts";

const profile = { lanes: [], routingPath: null, boardRepos: [], plansDir: null };
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function host() {
  return fakeHost({
    node: async (method, params: Record<string, unknown>) => {
      if (method === "orch/run") {
        try {
          const result = await runOrch({
            store: String(params.store),
            op: String(params.op),
            args: params.args,
            force: Boolean(params.force),
          });
          return { ok: true, result };
        } catch (e) {
          const code = e instanceof ToolError ? e.code : "ORCH_ERROR";
          return { ok: false, message: `${code}: ${e instanceof Error ? e.message : String(e)}` };
        }
      }
      if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "feat/x", head: "a".repeat(40), gh_repo: "o/r" } };
      return { ok: false, message: "UNEXPECTED " + method };
    },
  });
}

describe("Step 13 keel_run program entry", () => {
  it("isolates one failed PR and restores after a new Program/tool call", async () => {
    const store = mkdtempSync(join(tmpdir(), "keel-program-"));
    dirs.push(store);
    const h = host();
    const ctx = () => makeContext(h, "p", profile);
    const base = { goal: "program", repo_dir: "/repo", lead: "codex" as const };
    const init = await runTool(ctx(), "keel_run", { ...base, program: { op: "init", store } });
    expect(init.ok).toBe(true);
    const addBad = await runTool(ctx(), "keel_run", { ...base, program: { op: "add", store, id: "bad", track: "t", pr: 1 } });
    const addOk = await runTool(ctx(), "keel_run", { ...base, program: { op: "add", store, id: "ok", track: "t", pr: 2 } });
    expect(addBad.ok).toBe(true);
    expect(addOk.ok).toBe(true);
    const first = await runTool(ctx(), "keel_run", { ...base, program: { op: "tick", store } });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const started = first.result as { started: string[] };
    expect(started.started.sort()).toEqual(["bad", "ok"]);
    await withRun(h, "run-ok", (raw) => {
      const s = raw as unknown as GraphRunState;
      s.status = "done";
      s.next = { kind: "done", summary: "ok" };
    });
    await withRun(h, "run-bad", (raw) => {
      delete raw.spec_id;
      delete raw.cursor;
    });
    const second = await runTool(ctx(), "keel_run", { ...base, program: { op: "tick", store } });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const tick = second.result as { stopped: string[]; errors: { unit: string }[] };
    expect(tick.stopped).toEqual(["bad"]);
    expect(tick.errors.some((e) => e.unit === "bad")).toBe(true);
    const restore = await runTool(ctx(), "keel_run", { ...base, program: { op: "restore", store } });
    expect(restore.ok).toBe(true);
    if (!restore.ok) return;
    const units = (restore.result as { units: { id: string; state: string }[] }).units;
    expect(units.find((u) => u.id === "ok")?.state).toBe("done");
    expect(units.find((u) => u.id === "bad")?.state).toBe("stopped");
    expect(h.files.has(graphStatePath("run-ok"))).toBe(true);
  });
});
