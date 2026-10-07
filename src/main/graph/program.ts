// Multi-PR program: rolling window, worker-slot queue, batched human gates, isolated unit failure.
// startRun / advanceRun are injected; this module does not own the interpreter.

import type { Frontier, InboxPointer, OpenGate, Unit } from "../../node/orch/store.ts";

export const DEFAULT_CONCURRENT_RUNS = 4;

export type UnitState = "pending" | "running" | "blocked" | "done" | "stopped";

export interface OrchClient {
  unitsAdd(params: { id: string; track: string; brief?: string }): Promise<Unit>;
  unitsSet(params: { id: string; state: string; branch?: string; pr?: number; sha?: string }): Promise<Unit>;
  unitsList(params?: { state?: string; track?: string }): Promise<readonly Unit[]>;
  inboxPush(params: { agent: string; unit: string; status: string; report?: string }): Promise<unknown>;
  inboxDrain(): Promise<readonly InboxPointer[]>;
  gatesPark(params: { id: string; question: string; options: string; defaultAnswer: string }): Promise<OpenGate>;
  gatesList(): Promise<readonly OpenGate[]>;
  frontierShow(): Promise<Frontier>;
  frontierSet(value: Frontier): Promise<Frontier>;
}

export interface RunReport {
  readonly run_id: string;
  readonly unit_id: string;
  readonly status: "running" | "done" | "stopped" | "blocked";
  readonly head_sha?: string;
  readonly merged?: boolean;
  readonly human_gate?: { readonly id: string; readonly question: string; readonly options: string; readonly defaultAnswer: string };
  readonly error?: string;
}

export interface WorkerLimit {
  readonly hard_limit: number;
  readonly remaining_slots: number;
}

export interface ProgramDeps {
  readonly orch: OrchClient;
  readonly startRun: (input: { unit: Unit; run_id: string }) => Promise<{ run_id: string }>;
  readonly advanceRun: (input: { unit: Unit; run_id: string }) => Promise<RunReport>;
  readonly workerLimit: () => WorkerLimit | Promise<WorkerLimit>;
  readonly concurrentRuns?: number;
}

export interface TickError {
  readonly unit: string;
  readonly phase: "start" | "advance";
  readonly message: string;
}

export interface TickResult {
  readonly started: readonly string[];
  readonly queued_window: readonly string[];
  readonly queued_workers: readonly string[];
  readonly advanced: readonly string[];
  readonly stopped: readonly string[];
  readonly blocked: readonly string[];
  readonly human_gates: readonly OpenGate[];
  readonly frontier_advanced: boolean;
  readonly errors: readonly TickError[];
}

export function runIdFor(unitId: string): string {
  return `run-${unitId}`;
}

export function shouldAdvanceFrontier(report: RunReport, previousSha: string): "merged" | "new_head" | null {
  if (report.merged) return "merged";
  if (report.head_sha && report.head_sha !== previousSha) return "new_head";
  return null;
}

function asState(value: string): UnitState {
  if (value === "running" || value === "blocked" || value === "done" || value === "stopped") return value;
  return "pending";
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  return String(e);
}

function wakeFirst(units: readonly Unit[], wake: ReadonlySet<string>): Unit[] {
  return [...units].sort((a, b) => Number(wake.has(b.id)) - Number(wake.has(a.id)));
}

export async function advanceFrontierSnapshot(
  current: Frontier,
  event: { reason: "merged" | "new_head"; pr: number; sha: string; branches?: string },
): Promise<Frontier> {
  const prs = current.prs.map((row) => {
    if (row.pr !== event.pr) return row;
    return {
      ...row,
      sha: event.sha,
      state: event.reason === "merged" ? ("MERGED" as const) : row.state,
    };
  });
  if (!prs.some((row) => row.pr === event.pr)) {
    prs.push({
      pr: event.pr,
      branches: event.branches ?? `pr-${event.pr}`,
      sha: event.sha,
      state: event.reason === "merged" ? "MERGED" : "OPEN",
    });
  }
  return {
    generation: current.generation + 1,
    prs,
    lowestUnmerged: prs.find((row) => row.state === "OPEN")?.pr ?? null,
  };
}

export class Program {
  private readonly orch: OrchClient;
  private readonly startRun: ProgramDeps["startRun"];
  private readonly advanceRun: ProgramDeps["advanceRun"];
  private readonly workerLimit: ProgramDeps["workerLimit"];
  private readonly window: number;

  constructor(deps: ProgramDeps) {
    this.orch = deps.orch;
    this.startRun = deps.startRun;
    this.advanceRun = deps.advanceRun;
    this.workerLimit = deps.workerLimit;
    this.window = deps.concurrentRuns ?? DEFAULT_CONCURRENT_RUNS;
  }

  async addUnit(spec: { id: string; track: string; brief?: string; pr?: number }): Promise<Unit> {
    const unit = await this.orch.unitsAdd({ id: spec.id, track: spec.track, brief: spec.brief });
    if (spec.pr !== undefined) return this.orch.unitsSet({ id: unit.id, state: unit.state, pr: spec.pr });
    return unit;
  }

  async restore(): Promise<readonly Unit[]> {
    return this.orch.unitsList();
  }

  async tick(): Promise<TickResult> {
    const wake = new Set(await this.ingestInbox());
    const units = wakeFirst(await this.orch.unitsList(), wake);
    const started: string[] = [];
    const queued_window: string[] = [];
    const queued_workers: string[] = [];
    const advanced: string[] = [];
    const stopped: string[] = [];
    const blocked: string[] = [];
    const errors: TickError[] = [];
    let frontier_advanced = false;

    let inflight = units.filter((u) => asState(u.state) === "running").length;
    const limit = await this.workerLimit();
    let slots = Math.max(0, limit.remaining_slots);

    for (const unit of units) {
      if (asState(unit.state) !== "pending") continue;
      if (inflight >= this.window) {
        queued_window.push(unit.id);
        continue;
      }
      if (slots <= 0) {
        queued_workers.push(unit.id);
        continue;
      }
      const run_id = runIdFor(unit.id);
      try {
        await this.startRun({ unit, run_id });
        await this.orch.unitsSet({ id: unit.id, state: "running", branch: run_id, ...(unit.pr ? { pr: Number(unit.pr) } : {}) });
        inflight += 1;
        slots -= 1;
        started.push(unit.id);
      } catch (e) {
        await this.orch.unitsSet({ id: unit.id, state: "stopped" });
        stopped.push(unit.id);
        errors.push({ unit: unit.id, phase: "start", message: errorMessage(e) });
      }
    }

    const live = wakeFirst(
      (await this.orch.unitsList()).filter((u) => asState(u.state) === "running"),
      wake,
    );
    for (const unit of live) {
      try {
        const report = await this.advanceRun({ unit, run_id: unit.branch || runIdFor(unit.id) });
        advanced.push(unit.id);
        const event = shouldAdvanceFrontier(report, unit.sha);
        if (event) {
          const pr = report.merged || report.head_sha ? Number(unit.pr || 0) : 0;
          if (pr > 0 && report.head_sha) {
            const next = await advanceFrontierSnapshot(await this.orch.frontierShow(), { reason: event, pr, sha: report.head_sha });
            await this.orch.frontierSet(next);
            frontier_advanced = true;
          }
        }
        if (report.status === "blocked" && report.human_gate) {
          await this.orch.gatesPark(report.human_gate);
          await this.orch.unitsSet({ id: unit.id, state: "blocked", ...(report.head_sha ? { sha: report.head_sha } : {}) });
          blocked.push(unit.id);
        } else if (report.status === "stopped") {
          await this.orch.unitsSet({ id: unit.id, state: "stopped", ...(report.head_sha ? { sha: report.head_sha } : {}) });
          stopped.push(unit.id);
        } else if (report.status === "done") {
          await this.orch.unitsSet({
            id: unit.id,
            state: "done",
            ...(report.head_sha ? { sha: report.head_sha } : {}),
          });
        } else if (report.head_sha) {
          await this.orch.unitsSet({ id: unit.id, state: "running", sha: report.head_sha });
        }
      } catch (e) {
        await this.orch.unitsSet({ id: unit.id, state: "stopped" });
        stopped.push(unit.id);
        errors.push({ unit: unit.id, phase: "advance", message: errorMessage(e) });
      }
    }

    const human_gates = await this.orch.gatesList();
    return { started, queued_window, queued_workers, advanced, stopped, blocked, human_gates, frontier_advanced, errors };
  }

  /** Inbox is a wake hint only: never copy pointer.status onto the unit. */
  private async ingestInbox(): Promise<string[]> {
    const pointers = await this.orch.inboxDrain();
    return pointers.map((p) => p.unit).filter(Boolean);
  }
}

