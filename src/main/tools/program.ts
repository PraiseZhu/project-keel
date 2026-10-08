// Production entry for the multi-PR Program: rolling window, isolated unit failure, restore.
// Plan Step 13 did not name the tool; this maps add/tick/restore onto Program + orch/run.

import { node, requireString, type ToolContext } from "../context.ts";
import { loadGraphStates } from "../graph-snapshot.ts";
import { createRun, advance } from "../graph/interpreter.ts";
import { readPrFacts } from "../graph/pr-facts.ts";
import { DEFAULT_CONCURRENT_RUNS, Program, type OrchClient, type RunReport } from "../graph/program.ts";
import type { GraphRunState, Next } from "../graph/state.ts";
import { KeelError } from "../host.ts";
import type { Frontier, InboxPointer, OpenGate, Unit } from "../../node/orch/store.ts";
import type { Harness } from "../../shared/manual/schema.ts";

const LEADS = new Set<Harness>(["codex", "claude-code", "pi"]);
const CI_WAIT_NODES = new Set(["wait-ci", "ci-rerun-once"]);
const TOOL_PASS_NODES = new Set(["report", "report-ready"]);

function orchClient(ctx: ToolContext, store: string): OrchClient {
  const call = <T>(op: string, args?: Record<string, unknown>) =>
    node<T>(ctx, "orch/run", { store, op, force: true, ...(args ? { args } : {}) });
  return {
    unitsAdd: (params) => call<Unit>("units.add", params),
    unitsSet: (params) => call<Unit>("units.set", params),
    unitsList: (params) => call<readonly Unit[]>("units.list", params ?? {}),
    inboxPush: (params) => call("inbox.push", params),
    inboxDrain: () => call<readonly InboxPointer[]>("inbox.drain"),
    gatesPark: (params) => call<OpenGate>("gates.park", params),
    gatesList: () => call<readonly OpenGate[]>("gates.list"),
    frontierShow: () => call<Frontier>("frontier.show"),
    async frontierSet(value) {
      return value;
    },
  };
}

function waitOnFromFacts(nextAction: string): "wait" | "ci_red" | "conflict" | "threads" | "head_moved" | "ok" {
  if (nextAction === "wait_for_ci" || nextAction === "wait_for_review") return "wait";
  if (nextAction === "classify_ci_failure") return "ci_red";
  if (nextAction === "report_conflict_rebase_needed") return "conflict";
  if (nextAction === "triage_review_threads") return "threads";
  if (nextAction === "verify_current_head") return "head_moved";
  return "ok";
}

function ghRepoOf(state: GraphRunState): string | undefined {
  const cand = [state.gh_repo, state.pr_binding?.repo, state.repo];
  return cand.find((v): v is string => typeof v === "string" && /^[^/]+\/[^/]+$/.test(v));
}

function reportOf(unit: Unit, run_id: string, next: Next, state: GraphRunState): RunReport {
  if (state.status === "done") return { run_id, unit_id: unit.id, status: "done", next };
  if (state.status === "stopped") return { run_id, unit_id: unit.id, status: "stopped", next };
  if (next.kind === "decide") {
    return {
      run_id,
      unit_id: unit.id,
      status: "blocked",
      next,
      human_gate: {
        id: next.gate_id,
        question: next.question,
        options: next.options.join("|"),
        defaultAnswer: next.options[0] ?? "stop",
      },
    };
  }
  return { run_id, unit_id: unit.id, status: "running", next };
}

function makeProgram(ctx: ToolContext, args: Record<string, unknown>, store: string): Program {
  const leadRaw = typeof args.lead === "string" ? args.lead : "codex";
  const lead = (LEADS.has(leadRaw as Harness) ? leadRaw : "codex") as Harness;
  const profileId = typeof args.profile === "string" && args.profile.trim() ? args.profile : "sol";
  const remaining = typeof args.remaining_slots === "number" ? args.remaining_slots : 32;
  const window = typeof args.window === "number" ? args.window : DEFAULT_CONCURRENT_RUNS;
  const repoDir = typeof args.repo_dir === "string" && args.repo_dir.trim() ? args.repo_dir : undefined;
  const goal = typeof args.goal === "string" && args.goal.trim() ? args.goal : undefined;
  return new Program({
    orch: orchClient(ctx, store),
    concurrentRuns: window,
    workerLimit: () => ({ hard_limit: 32, remaining_slots: remaining }),
    async startRun({ unit }) {
      const existing = unit.branch && unit.branch.startsWith("run-") ? unit.branch : undefined;
      const run_id = existing ?? `run-${unit.id}-${ctx.host.now().toString(16)}-${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
      if (existing) {
        const states = await loadGraphStates(ctx.host);
        if (states.some((r) => (r as { run_id?: string }).run_id === existing)) return { run_id: existing };
      }
      const git = repoDir
        ? await node<{ root?: string; gh_repo?: string }>(ctx, "git/state", { repo_dir: repoDir }).catch(() => ({} as { root?: string; gh_repo?: string }))
        : {};
      const pr = unit.pr ? Number(unit.pr) : undefined;
      await createRun(ctx.host, {
        run_id,
        spec_id: "pr",
        profile_id: profileId,
        lead_harness: lead,
        task_type: "pr",
        entry: "wait-ci",
        goal: unit.brief || goal || (pr ? `推进 PR ${pr}` : unit.id),
        ...(repoDir ? { invocation_dir: repoDir } : {}),
        ...(git.root ? { repo_root: git.root } : {}),
        ...(git.gh_repo ? { gh_repo: git.gh_repo } : {}),
        ...(pr ? { pr, pr_explicit: true } : {}),
        now: ctx.host.now(),
      });
      return { run_id };
    },
    async advanceRun({ unit, run_id }): Promise<RunReport> {
      const states = await loadGraphStates(ctx.host);
      const st = states.find((r) => (r as { run_id?: string }).run_id === run_id) as GraphRunState | undefined;
      if (!st) throw new KeelError("RUN_NOT_FOUND", `program 找不到 run ${run_id}`);
      if (st.status === "done") return { run_id, unit_id: unit.id, status: "done", next: st.next };
      if (st.status === "stopped") return { run_id, unit_id: unit.id, status: "stopped", next: st.next };
      let next = st.next;
      let state = st;
      const cursor = st.cursor ?? "";
      if (CI_WAIT_NODES.has(cursor)) {
        const stepped = await advance(ctx.host, run_id, { type: "tick" });
        next = stepped.next;
        state = stepped.state;
        if (CI_WAIT_NODES.has(state.cursor ?? "") && state.pr != null) {
          const facts = await readPrFacts(ctx, {
            pr: state.pr,
            ...(ghRepoOf(state) ? { repo: ghRepoOf(state) } : {}),
            ...(state.worktree ?? state.invocation_dir ? { repo_dir: state.worktree ?? state.invocation_dir } : {}),
          });
          const on = waitOnFromFacts(facts.nextAction);
          if (on !== "wait") {
            const moved = await advance(ctx.host, run_id, { type: "wait_done", on });
            next = moved.next;
            state = moved.state;
          }
        }
        return reportOf(unit, run_id, next, state);
      }
      if (TOOL_PASS_NODES.has(cursor) || cursor === "done") {
        const moved = await advance(ctx.host, run_id, cursor === "done" ? { type: "tick" } : { type: "wait_done", on: "ok" });
        return reportOf(unit, run_id, moved.next, moved.state);
      }
      const moved = await advance(ctx.host, run_id, { type: "tick" });
      return reportOf(unit, run_id, moved.next, moved.state);
    },
  });
}

export async function keelProgram(ctx: ToolContext, args: Record<string, unknown>) {
  const op = requireString(args, "op");
  const store = requireString(args, "store");
  if (op === "init") {
    return node(ctx, "orch/run", { store, op: "init", force: true });
  }
  const program = makeProgram(ctx, args, store);
  if (op === "add") {
    return program.addUnit({
      id: requireString(args, "id"),
      track: requireString(args, "track"),
      ...(typeof args.brief === "string" ? { brief: args.brief } : {}),
      ...(typeof args.pr === "number" ? { pr: args.pr } : {}),
    });
  }
  if (op === "tick") return program.tick();
  if (op === "restore") return { units: await program.restore() };
  throw new KeelError("INVALID_INPUT", `keel_program 不认识 op=${op}。`);
}
