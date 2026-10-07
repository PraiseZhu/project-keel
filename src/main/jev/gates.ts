// Graph gate runner: deterministic first, then Jev, then direction route or mechanical default.
// Must not import templates.ts, judge.ts, policy.ts, or tools/pstack.ts.

import { evaluate, answerConfidence, type EvaluateArgs } from "./client.ts";
import { DEFAULT_THRESHOLDS } from "../../shared/types.ts";
import type { ToolContext } from "../context.ts";
import { sha256 } from "../ledger.ts";
import { GATES, gateOf, type Evidence, type GateDef, type GateId } from "../graph/gates.ts";

export type GateRoute = "act" | "lead" | "astra" | "default";
export type DirectionGate = "lead" | "astra";
export type GraphKind = "bug-fix" | "feature" | "refactoring" | "investigation" | "pr";

export interface GateDecision {
  readonly gate: GateId;
  readonly deterministic?: string;
  readonly jev?: { readonly choice: string; readonly confidence: number };
  readonly routed: GateRoute;
  readonly value: string;
}

export interface GateStore {
  get(runId: string, gateId: GateId, evidenceSha: string): Promise<GateDecision | null>;
  set(runId: string, gateId: GateId, evidenceSha: string, decision: GateDecision): Promise<void>;
}

export type JevStub = (args: EvaluateArgs) => Promise<{ choice: string; confidence: number } | null>;

export interface RunGateOpts {
  readonly run_id: string;
  readonly direction_gate?: DirectionGate;
  readonly graph?: GraphKind;
  readonly store?: GateStore;
  readonly jev?: JevStub;
}

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map((k) => [k, canonicalize((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function memoryGateStore(): GateStore {
  const data = new Map<string, GateDecision>();
  const chains = new Map<string, Promise<unknown>>();
  const key = (runId: string, gateId: string, sha: string) => `${runId}:${gateId}:${sha}`;
  const serialized = <T>(runId: string, work: () => Promise<T>): Promise<T> => {
    const prev = chains.get(runId) ?? Promise.resolve();
    const next = prev.then(work, work);
    chains.set(runId, next.then(() => undefined, () => undefined));
    return next;
  };
  return {
    get: async (runId, gateId, sha) => data.get(key(runId, gateId, sha)) ?? null,
    set: (runId, gateId, sha, decision) =>
      serialized(runId, async () => {
        data.set(key(runId, gateId, sha), decision);
      }),
  };
}

function questionArgs(gate: GateDef, evidence: Evidence): EvaluateArgs {
  const q = gate.question(evidence);
  return {
    state: q.state,
    questions: {
      [gate.id]: { type: "choice", instructions: q.instructions, criteria: q.criteria },
    },
  };
}

async function askJev(ctx: ToolContext, gate: GateDef, evidence: Evidence, stub?: JevStub): Promise<{ choice: string; confidence: number } | null> {
  const args = questionArgs(gate, evidence);
  const allowed = new Set(gate.options(evidence));
  try {
    const got = stub ? await stub(args) : await defaultJev(ctx, args);
    if (!got || !allowed.has(got.choice)) return null;
    return got;
  } catch {
    return null;
  }
}

async function defaultJev(ctx: ToolContext, args: EvaluateArgs): Promise<{ choice: string; confidence: number } | null> {
  const r = await evaluate(ctx.host, args, ctx.callId);
  const id = Object.keys(args.questions)[0];
  if (!id) return null;
  const a = r.answers[id];
  if (!a) return null;
  return { choice: String(a.choice ?? ""), confidence: answerConfidence(a) };
}

function directionRoute(gate: GateDef, opts: RunGateOpts): "lead" | "astra" {
  if (gate.forceLeadOnLow) return "lead";
  if (opts.graph === "investigation") return "lead";
  return opts.direction_gate === "astra" ? "astra" : "lead";
}

export async function runGate(ctx: ToolContext, gate: GateDef | GateId, evidence: Evidence, opts: RunGateOpts): Promise<GateDecision> {
  const def = typeof gate === "string" ? gateOf(gate) : gate;
  const store = opts.store;
  const sha = await sha256(canonicalize(evidence));
  if (store) {
    const hit = await store.get(opts.run_id, def.id, sha);
    if (hit) return hit;
  }
  const decided = await decide(ctx, def, evidence, opts);
  if (store) await store.set(opts.run_id, def.id, sha, decided);
  return decided;
}

async function decide(ctx: ToolContext, def: GateDef, evidence: Evidence, opts: RunGateOpts): Promise<GateDecision> {
  const det = def.deterministic(evidence);
  if (det !== undefined) return { gate: def.id, deterministic: det, routed: "act", value: det };
  const threshold = ctx.thresholds?.act ?? DEFAULT_THRESHOLDS.act;
  const jev = await askJev(ctx, def, evidence, opts.jev);
  if (jev && jev.confidence >= threshold)
    return { gate: def.id, jev, routed: "act", value: jev.choice };
  if (def.kind === "direction") {
    return { gate: def.id, ...(jev ? { jev } : {}), routed: directionRoute(def, opts), value: jev?.choice ?? def.fallback(evidence) };
  }
  return { gate: def.id, ...(jev ? { jev } : {}), routed: "default", value: def.fallback(evidence) };
}

export { GATES, gateOf };
