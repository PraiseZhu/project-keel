// Wake the lead when a run is waiting on it. External continue / card / notify
// go through NudgePorts so this module stays unwired from ghost.json and tools.

import { ENABLE_AUTOPILOT, PAUSE_RUN, renderNudgeCard, runIdFromCardAction, type CardActionEvent, type NudgeCard } from "./cards.ts";

export const IDLE_MS = 3 * 60_000;
export const NUDGE_INTERVAL_MS = 10_000;
export const MAX_NUDGE_STREAK = 3;
export const LEAD_NEXT = new Set(["setup", "dispatch", "reconcile", "recover", "decide"]);
export const QUIET_STATUS = new Set(["paused", "stopped", "done", "waiting_human"]);
export const ASSOCIATED_STATUSES = new Set(["created", "resumed", "active", "queued"]);

export function nudgePrompt(runId: string): string {
  return `KEEL：run ${runId} 未完成，调用 keel_status 取下一步。`;
}

export type DispatchState = "planned" | "accepted" | "running" | "reported" | "terminal" | "reconciling";
export type RunStatus = "running" | "paused" | "stopped" | "done" | "waiting_human" | "stalled";

export interface NudgeNode {
  readonly id?: string;
  readonly dispatch_state?: DispatchState;
  readonly started_at?: number;
  readonly timebox_ms?: number;
  readonly queued?: boolean;
  readonly delivered?: boolean;
}

export interface NudgeRun {
  readonly run_id: string;
  readonly status: RunStatus;
  readonly version: number;
  readonly next?: { readonly kind: string };
  readonly last_keel_call_at?: number;
  readonly associated?: boolean;
  readonly session_id?: string;
  readonly nodes?: readonly NudgeNode[];
}

export interface TurnEnd {
  readonly endReason: "completed" | "interrupted" | "error";
}

export interface ShouldNudge {
  readonly nudge: boolean;
  readonly pause: boolean;
  readonly reason: string;
}

export function isTimedOut(node: NudgeNode, now: number): boolean {
  if (node.dispatch_state !== "running") return false;
  if (node.started_at === undefined || node.timebox_ms === undefined) return false;
  return now - node.started_at > node.timebox_ms;
}

export function pendingLeadAction(run: NudgeRun, now: number): boolean {
  if (run.next && LEAD_NEXT.has(run.next.kind)) return true;
  for (const n of run.nodes ?? []) {
    if (n.dispatch_state === "planned" || n.dispatch_state === "reconciling") return true;
    if (n.dispatch_state === "accepted") return true;
    if (isTimedOut(n, now)) return true;
  }
  return false;
}

export function onlyHealthyRunning(run: NudgeRun, now: number): boolean {
  if (pendingLeadAction(run, now)) return false;
  const inflight = (run.nodes ?? []).filter((n) => n.dispatch_state === "planned" || n.dispatch_state === "accepted" || n.dispatch_state === "running" || n.dispatch_state === "reconciling");
  return inflight.length > 0 && inflight.every((n) => n.dispatch_state === "running" && !isTimedOut(n, now));
}

export function shouldNudge(run: NudgeRun, now: number, opts: { idleMs?: number; turn?: TurnEnd } = {}): ShouldNudge {
  const idleMs = opts.idleMs ?? IDLE_MS;
  if (QUIET_STATUS.has(run.status)) return { nudge: false, pause: false, reason: "quiet" };
  if (opts.turn?.endReason === "interrupted") return { nudge: false, pause: true, reason: "interrupted" };
  if (opts.turn?.endReason === "completed") return { nudge: true, pause: false, reason: "turn_completed" };
  if (onlyHealthyRunning(run, now)) return { nudge: false, pause: false, reason: "healthy_running" };
  if (!pendingLeadAction(run, now)) return { nudge: false, pause: false, reason: "no_lead_action" };
  const last = run.last_keel_call_at ?? 0;
  if (now - last < idleMs) return { nudge: false, pause: false, reason: "idle_wait" };
  return { nudge: true, pause: false, reason: "idle" };
}

export interface AssociateSessionReq {
  readonly mode: "continue";
  readonly userActionToken: string;
  readonly promptTemplate: string;
  readonly userMessage: string;
  readonly event: "card-action";
}

export interface ContinueSessionReq {
  readonly mode: "continue";
  readonly trigger: "background";
  readonly sessionId?: string;
  readonly prompt: string;
}

export interface AgentRunResult {
  readonly ok: boolean;
  readonly status?: string;
  readonly errorCode?: string;
  readonly message?: string;
}

export interface NudgePorts {
  associateSession(req: AssociateSessionReq): Promise<AgentRunResult>;
  continueSession(req: ContinueSessionReq): Promise<AgentRunResult>;
  presentCard(card: NudgeCard): Promise<void> | void;
  notifyUser(message: string): Promise<void> | void;
}

export interface NudgeConfig {
  readonly idleMs?: number;
  readonly intervalMs?: number;
  readonly maxStreak?: number;
  /** P0-2 unavailable: never call continueSession, always present a card. */
  readonly cardOnly?: boolean;
  now(): number;
}

export interface NudgeState {
  lastSentAt: number | null;
  inFlight: boolean;
  consecutiveWithoutProgress: number;
  versionAtLastNudge: number | null;
  associated: boolean;
  stalled: boolean;
  paused: boolean;
  lastHostStatus?: string;
  lastHostError?: string;
}

export function newNudgeState(associated = false): NudgeState {
  return { lastSentAt: null, inFlight: false, consecutiveWithoutProgress: 0, versionAtLastNudge: null, associated, stalled: false, paused: false };
}

function isUnassociated(code?: string, message?: string): boolean {
  const t = `${code ?? ""} ${message ?? ""}`.toUpperCase();
  return /NOT_ASSOCIATED|UNASSOCIATED|NO_ASSOCIATION|未关联/.test(t);
}

function associatedFromHost(r: AgentRunResult): boolean {
  if (!r.ok) return false;
  if (!r.status) return true;
  return ASSOCIATED_STATUSES.has(r.status);
}

export type NudgeAction = "continue" | "card" | "skip" | "stall" | "pause";

export interface NudgeOutcome {
  readonly action: NudgeAction;
  readonly reason: string;
  readonly prompt?: string;
  readonly card?: NudgeCard;
  readonly notify?: string;
  readonly pause?: boolean;
  readonly stalled?: boolean;
}

export type CardActionResult =
  | { ok: true; action: "associate"; run_id: string; status?: string }
  | { ok: true; action: "pause"; run_id: string }
  | { ok: false; error: string; run_id?: string };

export class NudgeController {
  private readonly byRun = new Map<string, NudgeState>();

  constructor(
    private readonly ports: NudgePorts,
    private readonly config: NudgeConfig,
  ) {}

  stateOf(runId: string): NudgeState {
    return this.byRun.get(runId) ?? newNudgeState();
  }

  async handleCardAction(ev: CardActionEvent): Promise<CardActionResult> {
    const runId = runIdFromCardAction(ev);
    if (!runId) return { ok: false, error: "缺少 run_id" };
    if (ev.actionId === PAUSE_RUN) {
      const s = this.stateOf(runId);
      s.associated = false;
      s.paused = true;
      this.byRun.set(runId, s);
      return { ok: true, action: "pause", run_id: runId };
    }
    if (ev.actionId !== ENABLE_AUTOPILOT) return { ok: false, error: `未知卡片动作 ${ev.actionId}`, run_id: runId };
    if (!ev.userActionToken) return { ok: false, error: "缺少 userActionToken", run_id: runId };
    const prompt = nudgePrompt(runId);
    const r = await this.ports.associateSession({
      mode: "continue",
      userActionToken: ev.userActionToken,
      promptTemplate: prompt,
      userMessage: prompt,
      event: "card-action",
    });
    const s = this.stateOf(runId);
    s.lastHostStatus = r.status;
    s.lastHostError = r.ok ? undefined : (r.errorCode ?? r.message);
    s.associated = associatedFromHost(r);
    if (s.associated) {
      s.paused = false;
      s.stalled = false;
      s.consecutiveWithoutProgress = 0;
      s.versionAtLastNudge = null;
    }
    this.byRun.set(runId, s);
    if (!s.associated) return { ok: false, error: r.errorCode ?? r.message ?? "associate_failed", run_id: runId };
    return { ok: true, action: "associate", run_id: runId, status: r.status };
  }

  async onTurnEnd(run: NudgeRun, turn: TurnEnd): Promise<NudgeOutcome> {
    return this.maybeNudge(run, { turn });
  }

  async maybeNudge(run: NudgeRun, opts: { turn?: TurnEnd } = {}): Promise<NudgeOutcome> {
    const now = this.config.now();
    const idleMs = this.config.idleMs ?? IDLE_MS;
    const intervalMs = this.config.intervalMs ?? NUDGE_INTERVAL_MS;
    const maxStreak = this.config.maxStreak ?? MAX_NUDGE_STREAK;
    const judged = shouldNudge(run, now, { idleMs, ...(opts.turn ? { turn: opts.turn } : {}) });
    if (judged.pause) return { action: "pause", reason: judged.reason, pause: true };
    if (!judged.nudge) return { action: "skip", reason: judged.reason };

    const state = this.byRun.get(run.run_id) ?? newNudgeState(Boolean(run.associated));
    if (state.paused) return { action: "skip", reason: "paused" };
    if (state.stalled) return { action: "skip", reason: "stalled" };
    if (state.inFlight) return { action: "skip", reason: "busy" };
    if (state.lastSentAt !== null && now - state.lastSentAt < intervalMs) return { action: "skip", reason: "interval" };

    if (state.versionAtLastNudge === run.version && state.consecutiveWithoutProgress >= maxStreak) {
      state.stalled = true;
      this.byRun.set(run.run_id, state);
      const notify = `KEEL：run ${run.run_id} 连续 ${maxStreak} 次叫醒无进展，已停推并开人工门。`;
      await this.ports.notifyUser(notify);
      return { action: "stall", reason: "no_progress", notify, stalled: true };
    }

    const prompt = nudgePrompt(run.run_id);
    const useCard = this.config.cardOnly || !state.associated;
    state.inFlight = true;
    state.lastSentAt = now;
    state.consecutiveWithoutProgress = state.versionAtLastNudge === run.version ? state.consecutiveWithoutProgress + 1 : 1;
    state.versionAtLastNudge = run.version;
    this.byRun.set(run.run_id, state);

    if (useCard) {
      const card = renderNudgeCard(run.run_id);
      try {
        await this.ports.presentCard(card);
      } finally {
        state.inFlight = false;
      }
      return { action: "card", reason: this.config.cardOnly ? "card_only" : "unassociated", prompt, card };
    }

    try {
      const r = await this.ports.continueSession({
        mode: "continue",
        trigger: "background",
        ...(run.session_id ? { sessionId: run.session_id } : {}),
        prompt,
      });
      if (!r.ok && isUnassociated(r.errorCode, r.message)) {
        state.associated = false;
        const card = renderNudgeCard(run.run_id, "关联已丢失");
        await this.ports.presentCard(card);
        return { action: "card", reason: "association_lost", prompt, card };
      }
      if (!r.ok) return { action: "skip", reason: r.errorCode ?? "continue_failed" };
      return { action: "continue", reason: judged.reason, prompt };
    } finally {
      state.inFlight = false;
    }
  }
}
