// G-route before createRun. Persist pending args when the gate needs a lead answer.

import type { ToolContext } from "../context.ts";
import { KeelError } from "../host.ts";
import { runGate } from "../jev/gates.ts";
import { GATES, keywordCandidates, type Evidence } from "./gates.ts";
import type { Next } from "./state.ts";
import { TASK_TYPES, type GraphTaskType } from "../../shared/graph/pstack.ts";
import type { Profile } from "../../shared/manual/schema.ts";

export interface RoutePending {
  readonly goal: string;
  readonly repo_dir: string;
  readonly profile_id: string;
  readonly lead?: string;
  readonly playbook?: string;
  readonly sc: { id: string; text: string; verify?: string; min_level?: "live-ui-verified" | "unit-test-verified" | "type-check-only" }[];
  readonly scope?: string[];
  readonly pr?: number | string;
  readonly branch?: string;
}

export function isGraphTaskType(v: string): v is GraphTaskType {
  return (TASK_TYPES as readonly string[]).includes(v);
}

export async function resolveGraphTask(ctx: ToolContext, input: {
  goal: string;
  playbook?: string;
  pr?: number | string;
  run_id: string;
  profile: Profile;
}): Promise<{ taskType: GraphTaskType } | { decide: Next } | { astra: { options: string[]; question: string; jev?: unknown } }> {
  if (input.pr !== undefined && input.pr !== null && input.pr !== "") return { taskType: "pr" };
  if (input.playbook && isGraphTaskType(input.playbook)) return { taskType: input.playbook };
  const evidence: Evidence = { task: input.goal, goal: input.goal, ...(input.playbook ? { playbook: input.playbook } : {}) };
  const decision = await runGate(ctx, "G-route", evidence, {
    run_id: input.run_id,
    direction_gate: input.profile.direction_gate === "astra" ? "astra" : "lead",
  });
  if (decision.routed === "act" && isGraphTaskType(decision.value)) return { taskType: decision.value };
  const options = [...GATES["G-route"].options(evidence)];
  const question = GATES["G-route"].question(evidence).instructions;
  const resolvedOptions = options.length ? options : [...keywordCandidates(input.goal)];
  if (decision.routed === "astra") {
    return { astra: { options: resolvedOptions, question, jev: decision.jev } };
  }
  return {
    decide: {
      kind: "decide",
      gate_id: "G-route",
      question,
      options: resolvedOptions,
      context: { routed: decision.routed, jev: decision.jev },
    },
  };
}

export function routePendingPath(runId: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(runId)) throw new KeelError("INVALID_INPUT", "run_id 只能含小写字母、数字和连字符。");
  return `runs/${runId}/route-pending.json`;
}
