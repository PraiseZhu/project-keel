// Host event/card wiring (Cindy §4.5 / §4.6). Extracted so tests can drive it without cindy global.

import { cardUpdateMessage, parseCardActionEvent, parseTurnEndEvent, type NudgeCard } from "./graph/cards.ts";
import { NudgeController, drivenNudgeRuns, scanNudgeClock, type NudgeOutcome, type NudgeRun } from "./graph/nudge.ts";
import type { Host } from "./host.ts";
import { withRun } from "./store/runs.ts";

export function asNudgeRun(r: { run_id?: string; status?: string; updated_at?: unknown; next?: { kind?: string }; nodes?: Record<string, any> }): NudgeRun | null {
  if (!r?.run_id) return null;
  const nodes = Object.entries(r.nodes ?? {}).map(([id, n]) => ({
    id,
    dispatch_state: n.dispatch_state,
    started_at: n.started_at,
    timebox_ms: n.timebox_ms,
    queued: Boolean(n.queued_message_id),
  }));
  return {
    run_id: r.run_id,
    status: (r.status as NudgeRun["status"]) ?? "running",
    version: Number(r.updated_at ?? 0),
    ...(r.next?.kind ? { next: { kind: r.next.kind } } : {}),
    ...(typeof r.updated_at === "number" ? { last_keel_call_at: r.updated_at } : {}),
    associated: false,
    nodes,
  };
}

export function scannableNudgeRuns(runs: readonly NudgeRun[]): NudgeRun[] {
  return drivenNudgeRuns(runs).filter((r) => r.status !== "stalled");
}

export async function persistRunStatus(host: Host, runId: string, status: "paused" | "stalled"): Promise<void> {
  await withRun(host, runId, (state) => {
    state.status = status;
  });
}

export async function applyNudgeOutcome(host: Host, runId: string, out: NudgeOutcome): Promise<void> {
  if (out.action === "pause") await persistRunStatus(host, runId, "paused");
  else if (out.action === "stall") await persistRunStatus(host, runId, "stalled");
}

export function presentNudgeCard(send: (msg: unknown) => void, card: NudgeCard, callId = card.id): void {
  send(cardUpdateMessage(card, callId));
}

export async function handleCardActionMessage(
  nudge: NudgeController,
  host: Host,
  msg: unknown,
): Promise<{ handled: boolean; result?: unknown }> {
  const ev = parseCardActionEvent(msg);
  if (!ev) return { handled: false };
  const r = await nudge.handleCardAction(ev);
  if (r.ok && r.action === "pause") await persistRunStatus(host, r.run_id, "paused");
  return { handled: true, result: r };
}

export async function handleTurnEndMessage(
  nudge: NudgeController,
  host: Host,
  runs: readonly NudgeRun[],
  msg: unknown,
): Promise<{ handled: boolean }> {
  const turn = parseTurnEndEvent(msg);
  if (!turn) return { handled: false };
  for (const r of runs) {
    const out = await nudge.onTurnEnd(r, turn);
    await applyNudgeOutcome(host, r.run_id, out);
  }
  return { handled: true };
}

export async function tickNudgeClockFor(nudge: NudgeController, host: Host, runs: readonly NudgeRun[]): Promise<NudgeOutcome[]> {
  const scannable = scannableNudgeRuns(runs);
  const outcomes = await scanNudgeClock(nudge, scannable);
  for (let i = 0; i < scannable.length; i++) {
    const out = outcomes[i];
    const run = scannable[i];
    if (out && run) await applyNudgeOutcome(host, run.run_id, out);
  }
  return outcomes;
}
