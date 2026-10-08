// Production entry for the multi-PR Program: rolling window, isolated unit failure, restore.
// Plan Step 13 did not name the tool; this maps add/tick/restore onto Program + orch/run.

import { node, requireString, type ToolContext } from "../context.ts";
import { loadGraphStates } from "../graph-snapshot.ts";
import { createRun, advance } from "../graph/interpreter.ts";
import { DEFAULT_CONCURRENT_RUNS, Program, type OrchClient, type RunReport } from "../graph/program.ts";
import { KeelError } from "../host.ts";
import type { Frontier, InboxPointer, OpenGate, Unit } from "../../node/orch/store.ts";
import type { Harness } from "../../shared/manual/schema.ts";

const LEADS = new Set<Harness>(["codex", "claude-code", "pi"]);

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
    // Program writes a Frontier snapshot; orch frontier.set expects {repo, prs} and re-reads git.
    async frontierSet(value) {
      return value;
    },
  };
}

function makeProgram(ctx: ToolContext, args: Record<string, unknown>, store: string): Program {
  const leadRaw = typeof args.lead === "string" ? args.lead : "codex";
  const lead = (LEADS.has(leadRaw as Harness) ? leadRaw : "codex") as Harness;
  const profileId = typeof args.profile === "string" && args.profile.trim() ? args.profile : "sol";
  const remaining = typeof args.remaining_slots === "number" ? args.remaining_slots : 32;
  const window = typeof args.window === "number" ? args.window : DEFAULT_CONCURRENT_RUNS;
  return new Program({
    orch: orchClient(ctx, store),
    concurrentRuns: window,
    workerLimit: () => ({ hard_limit: 32, remaining_slots: remaining }),
    async startRun({ unit, run_id }) {
      await createRun(ctx.host, {
        run_id,
        spec_id: "pr",
        profile_id: profileId,
        lead_harness: lead,
        task_type: "pr",
        entry: "wait-ci",
        goal: unit.brief || (unit.pr ? `推进 PR ${unit.pr}` : unit.id),
        ...(unit.pr ? { pr: Number(unit.pr) } : {}),
        now: ctx.host.now(),
      });
      return { run_id };
    },
    async advanceRun({ unit, run_id }): Promise<RunReport> {
      const states = await loadGraphStates(ctx.host);
      const st = states.find((r) => (r as { run_id?: string }).run_id === run_id) as { status?: string; spec_id?: string; cursor?: string; pr_binding?: { head_sha?: string } } | undefined;
      if (!st) throw new KeelError("RUN_NOT_FOUND", `program 找不到 run ${run_id}`);
      if (st.status === "done") return { run_id, unit_id: unit.id, status: "done", ...(st.pr_binding?.head_sha ? { head_sha: st.pr_binding.head_sha } : {}) };
      if (st.status === "stopped") return { run_id, unit_id: unit.id, status: "stopped" };
      const { next, state } = await advance(ctx.host, run_id, { type: "tick" });
      if (state.status === "done") return { run_id, unit_id: unit.id, status: "done" };
      if (state.status === "stopped") return { run_id, unit_id: unit.id, status: "stopped" };
      if (next.kind === "decide") {
        return {
          run_id,
          unit_id: unit.id,
          status: "blocked",
          human_gate: {
            id: next.gate_id,
            question: next.question,
            options: next.options.join("|"),
            defaultAnswer: next.options[0] ?? "stop",
          },
        };
      }
      return { run_id, unit_id: unit.id, status: "running" };
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
