// Host event/card wiring (Cindy §4.5 / §4.6). Extracted so tests can drive it without cindy global.
// card-update callId must be a real tool-call id; never invent keel-nudge-* slots.

import { cardUpdateMessage, parseCardActionEvent, parseTurnEndEvent, renderNudgeCard, type NudgeCard } from "./graph/cards.ts";
import { loadGraphStates } from "./graph-snapshot.ts";
import { NudgeController, drivenNudgeRuns, scanNudgeClock, type NudgeOutcome, type NudgeRun } from "./graph/nudge.ts";
import type { Host } from "./host.ts";
import { withRun } from "./store/runs.ts";

export const NUDGE_CARD_TOOLS = new Set(["keel_run", "keel_status", "keel_wait"]);

export type HostNudgeRun = NudgeRun & { sol_session_id?: string };

export function asNudgeRun(r: Record<string, any> | null | undefined): HostNudgeRun | null {
  if (!r?.run_id) return null;
  const nodes = Object.entries((r.nodes ?? {}) as Record<string, any>).map(([id, n]) => ({
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
    ...(typeof r.sol_session_id === "string" ? { sol_session_id: r.sol_session_id } : {}),
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

export async function markPendingCard(host: Host, runId: string): Promise<void> {
  await withRun(host, runId, (state) => {
    state.nudge_pending_card = true;
  });
}

export async function rememberCardCallId(host: Host, runId: string, callId: string): Promise<void> {
  await withRun(host, runId, (state) => {
    const ids = Array.isArray(state.nudge_card_call_ids) ? [...(state.nudge_card_call_ids as string[])] : [];
    if (!ids.includes(callId)) ids.push(callId);
    state.nudge_card_call_ids = ids;
    state.nudge_pending_card = false;
  });
}

export async function runIdForCardCallId(host: Host, callId?: string): Promise<string | undefined> {
  if (!callId) return undefined;
  const runs = await loadGraphStates(host);
  for (const r of runs) {
    const bag = r as { run_id?: string; nudge_card_call_ids?: unknown };
    const ids = bag.nudge_card_call_ids;
    if (typeof bag.run_id === "string" && Array.isArray(ids) && ids.includes(callId)) return bag.run_id;
  }
}

export async function applyNudgeOutcome(host: Host, runId: string, out: NudgeOutcome): Promise<void> {
  if (out.action === "pause") await persistRunStatus(host, runId, "paused");
  else if (out.action === "stall") await persistRunStatus(host, runId, "stalled");
  else if (out.action === "card") await markPendingCard(host, runId);
}

/** Only send when callId is a real tool-call id. Missing callId = no host slot. */
export function presentNudgeCard(send: (msg: unknown) => void, card: NudgeCard, callId: string | undefined): boolean {
  if (!callId) return false;
  send(cardUpdateMessage(card, callId));
  return true;
}

export function runIdFromToolIo(args: unknown, result: unknown): string | undefined {
  const pick = (v: unknown) => (v && typeof v === "object" && typeof (v as { run_id?: unknown }).run_id === "string" ? (v as { run_id: string }).run_id : undefined);
  return pick(args) ?? pick(result);
}

export async function flushNudgeCardOnToolCall(opts: {
  host: Host;
  send: (msg: unknown) => void;
  tool: string;
  callId: string;
  args: unknown;
  result: unknown;
}): Promise<boolean> {
  if (!NUDGE_CARD_TOOLS.has(opts.tool) || !opts.callId) return false;
  const runId = runIdFromToolIo(opts.args, opts.result);
  if (!runId) return false;
  let pending = false;
  let unseen = true;
  await withRun(opts.host, runId, (state) => {
    pending = state.nudge_pending_card === true;
    unseen = !Array.isArray(state.nudge_card_call_ids) || (state.nudge_card_call_ids as unknown[]).length === 0;
  });
  if (!pending && !unseen) return false;
  const shown = presentNudgeCard(opts.send, renderNudgeCard(runId), opts.callId);
  if (shown) await rememberCardCallId(opts.host, runId, opts.callId);
  return shown;
}

export async function handleCardActionMessage(
  nudge: NudgeController,
  host: Host,
  msg: unknown,
  send?: (m: unknown) => void,
): Promise<{ handled: boolean; result?: unknown }> {
  const ev = parseCardActionEvent(msg);
  if (!ev) return { handled: false };
  const run_id = ev.run_id ?? (await runIdForCardCallId(host, ev.callId));
  const r = await nudge.handleCardAction({ ...ev, ...(run_id ? { run_id } : {}) });
  if (r.ok && r.action === "pause") await persistRunStatus(host, r.run_id, "paused");
  if (r.ok && r.action === "associate" && send && ev.spawnCallId) {
    send({
      type: "card-update",
      callId: ev.spawnCallId,
      v: 2,
      state: "done",
      html: `<div style="padding:12px"><p>run ${r.run_id} 已启用自动续跑。</p></div>`,
      height: 110,
    });
  }
  return { handled: true, result: r };
}

export async function handleTurnEndMessage(
  nudge: NudgeController,
  host: Host,
  runs: readonly HostNudgeRun[],
  msg: unknown,
  log: (line: string) => void = (line) => console.warn(line),
): Promise<{ handled: boolean; paused: string[] }> {
  const turn = parseTurnEndEvent(msg);
  if (!turn) return { handled: false, paused: [] };
  if (!turn.sessionId) {
    log("did-turn-end missing sessionId; pausing no runs");
    return { handled: true, paused: [] };
  }
  const paused: string[] = [];
  for (const r of runs) {
    if (r.sol_session_id !== turn.sessionId) continue;
    const out = await nudge.onTurnEnd(r, turn);
    await applyNudgeOutcome(host, r.run_id, out);
    if (out.action === "pause") paused.push(r.run_id);
  }
  return { handled: true, paused };
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
