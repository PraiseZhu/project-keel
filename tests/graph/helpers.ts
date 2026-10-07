import { advance, createRun, type AdvanceOpts } from "../../src/main/graph/interpreter.ts";
import type { InitRunOpts } from "../../src/main/graph/state.ts";
import { graphStatePath } from "../../src/main/store/runs.ts";
import type { GraphSpec } from "../../src/shared/graph/spec.ts";
import { fakeHost, type FakeHost } from "../helpers/fakeHost.ts";
import type { GraphRunState } from "../../src/main/graph/state.ts";

export function miniSpec(): GraphSpec {
  return {
    id: "bug-fix",
    version: 1,
    entry: "worker",
    exits: ["done", "stopped"],
    covers: ["bug-fix"],
    adaptations: [],
    nodes: [
      { id: "worker", kind: "dispatch", role: "worker", writes: true, playbook_steps: ["bug-fix#3"], timebox_min: 5, max_attempts: 3 },
      { id: "wait-ci", kind: "tool", writes: false, playbook_steps: ["babysit#6"], timebox_min: 15, max_attempts: 8 },
      { id: "research", kind: "plugin_task", role: "researcher", writes: false, playbook_steps: ["bug-fix#2"], timebox_min: 10, max_attempts: 3 },
      { id: "verify", kind: "dispatch", role: "verifier", writes: false, playbook_steps: ["shipping#1"], timebox_min: 5, max_attempts: 2 },
      { id: "g-retry", kind: "gate", writes: false, playbook_steps: [], timebox_min: 5, max_attempts: 3 },
      { id: "human", kind: "human", writes: false, playbook_steps: [], timebox_min: 5, max_attempts: 3 },
      { id: "done", kind: "tool", writes: false, playbook_steps: [], timebox_min: 1, max_attempts: 1 },
      { id: "stopped", kind: "tool", writes: false, playbook_steps: [], timebox_min: 1, max_attempts: 1 },
    ],
    edges: [
      { from: "worker", to: "wait-ci", on: "ok" },
      { from: "worker", to: "g-retry", on: "fail" },
      { from: "worker", to: "human", on: "fingerprint_repeat" },
      { from: "g-retry", to: "worker", on: "gate:retry" },
      { from: "g-retry", to: "stopped", on: "gate:stop" },
      { from: "g-retry", to: "human", on: "gate:escalate" },
      { from: "wait-ci", to: "research", on: "ok" },
      { from: "wait-ci", to: "worker", on: "ci_red" },
      { from: "wait-ci", to: "stopped", on: "fail" },
      { from: "research", to: "verify", on: "ok" },
      { from: "research", to: "stopped", on: "fail" },
      { from: "verify", to: "done", on: "ok" },
      { from: "verify", to: "stopped", on: "fail" },
      { from: "human", to: "stopped", on: "ok" },
      { from: "human", to: "stopped", on: "fail" },
    ],
  };
}

export async function boot(extra: Partial<InitRunOpts> = {}, host?: FakeHost): Promise<{ h: FakeHost; spec: GraphSpec; opts: AdvanceOpts }> {
  const h = host ?? fakeHost({
    node: (method: string) => {
      if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "feat/x", head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } };
      return { ok: false, message: method };
    },
  });
  const spec = miniSpec();
  await createRun(h, {
    run_id: extra.run_id ?? "run1",
    spec_id: spec.id,
    profile_id: "sol",
    lead_harness: "codex",
    task_type: "bug-fix",
    entry: spec.entry,
    goal: extra.goal ?? "fix the bug",
    worktree: extra.worktree ?? "/repo/.worktrees/keel-run1",
    now: h.now(),
    ...extra,
  });
  return { h, spec, opts: { spec } };
}

export function readState(h: FakeHost, runId = "run1"): GraphRunState {
  return JSON.parse(h.files.get(graphStatePath(runId))!) as GraphRunState;
}

export async function setupOk(h: FakeHost, spec: GraphSpec, runId = "run1") {
  await advance(h, runId, { type: "tick" }, { spec });
  return advance(h, runId, { type: "report", phase: "setup", outcome: { worker_permission_mode: "bypassPermissions", team_id: "team-1" }, session_id: "sol-1" }, { spec });
}
