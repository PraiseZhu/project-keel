// Wake the lead when a run is waiting on it. External continue / card / notify
// go through NudgePorts so this module stays unwired from ghost.json and tools.
// agent.run contract: Cindy 手册 §4.11 — promptTemplate 必须且只能出现一次 {{user_message}}。

import { ENABLE_AUTOPILOT, PAUSE_RUN, renderNudgeCard, runIdFromCardAction, type CardActionEvent, type NudgeCard } from "./cards.ts";

export const IDLE_MS = 3 * 60_000;
export const NUDGE_INTERVAL_MS = 10_000;
export const MAX_NUDGE_STREAK = 3;
export const LEAD_NEXT = new Set(["setup", "dispatch", "reconcile", "recover", "decide"]);
export const QUIET_STATUS = new Set(["paused", "stopped", "done", "waiting_human"]);
export const ASSOCIATED_STATUSES = new Set(["created", "resumed", "active", "queued"]);
/** Cindy §4.11: host fills userMessage into this slot; must occur exactly once. */
export const NUDGE_PROMPT_TEMPLATE = "{{user_message}}";

export function nudgePrompt(runId: string): string {
  return `KEEL：run ${runId} 未完成，调用 keel_status 取下一步。`;
}

export function countUserMessageSlots(template: string): number {
  return template.split("{{user_message}}").length - 1;
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
  if (onlyHealthyRunning(run, now)) return { nudge: false, pause: false, reason: "healthy_running" };
  if (opts.turn?.endReason === "completed") return { nudge: true, pause: false, reason: "turn_completed" };
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
  readonly event: { readonly actionId: string; readonly callId?: string };
}

export interface ContinueSessionReq {
  readonly mode: "continue";
  readonly trigger: "background";
  readonly sessionId?: string;
  readonly promptTemplate: string;
  readonly userMessage: string;
  readonly event: { readonly runId: string };
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
  consecutiveWithoutProgress: number;
  versionAtLastNudge: number | null;
  associated: boolean;
  stalled: boolean;
  paused: boolean;
  lastHostStatus?: string;
  lastHostError?: string;
  cardShownAt: number | null;
  cardShownVersion: number | null;
}

export function newNudgeState(associated = false): NudgeState {
  return { consecutiveWithoutProgress: 0, versionAtLastNudge: null, associated, stalled: false, paused: false, cardShownAt: null, cardShownVersion: null };
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

interface BackgroundPending {
  lastAttemptAt: number | null;
  /** Send window (controller epoch) in which this run last asked to continue. */
  lastSeenEpoch: number;
}

export class NudgeController {
  private readonly byRun = new Map<string, NudgeState>();
  /** Plugin-level: at most one background agent.run in flight. */
  private pluginInFlight = false;
  /** Plugin-level: last background agent.run attempt (success or host error). */
  private pluginLastSentAt: number | null = null;
  /** Runs waiting to background-continue; fairness uses oldest lastAttemptAt. */
  private readonly bgPending = new Map<string, BackgroundPending>();
  /** Increments on every background send attempt; a send window is the time between two attempts. */
  private epoch = 0;

  constructor(
    private readonly ports: NudgePorts,
    private readonly config: NudgeConfig,
  ) {}

  stateOf(runId: string): NudgeState {
    return this.byRun.get(runId) ?? newNudgeState();
  }

  /**
   * The clock calls this once per pass with every run it still drives. A waiter that is no
   * longer driven (deleted, finished elsewhere) leaves the queue here, so it can never hold
   * a fairness turn it will not use.
   */
  syncActive(runIds: Iterable<string>): void {
    const live = new Set(runIds);
    for (const id of [...this.bgPending.keys()]) if (!live.has(id)) this.bgPending.delete(id);
  }

  /**
   * Fairness only waits for runs that asked in the current send window. A run that stopped
   * asking (deleted, finished elsewhere) drops out by itself; repeated asks from one run
   * never push a live waiter out, because nothing is evicted.
   */
  private fairestPending(): string | undefined {
    let best: string | undefined;
    let bestT = Infinity;
    for (const [id, p] of this.bgPending) {
      if (p.lastSeenEpoch !== this.epoch) continue;
      const t = p.lastAttemptAt ?? Number.NEGATIVE_INFINITY;
      if (t < bestT) {
        bestT = t;
        best = id;
      }
    }
    return best;
  }

  async handleCardAction(ev: CardActionEvent): Promise<CardActionResult> {
    const runId = runIdFromCardAction(ev);
    if (!runId) return { ok: false, error: "缺少 run_id" };
    if (ev.actionId === PAUSE_RUN) {
      const s = this.stateOf(runId);
      s.associated = false;
      s.paused = true;
      this.byRun.set(runId, s);
      this.bgPending.delete(runId);
      return { ok: true, action: "pause", run_id: runId };
    }
    if (ev.actionId !== ENABLE_AUTOPILOT) return { ok: false, error: `未知卡片动作 ${ev.actionId}`, run_id: runId };
    if (!ev.userActionToken) return { ok: false, error: "缺少 userActionToken", run_id: runId };
    const prompt = nudgePrompt(runId);
    const r = await this.ports.associateSession({
      mode: "continue",
      userActionToken: ev.userActionToken,
      promptTemplate: NUDGE_PROMPT_TEMPLATE,
      userMessage: prompt,
      event: { actionId: ev.actionId, ...(ev.callId ? { callId: ev.callId } : {}) },
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
    if (!judged.nudge) {
      this.bgPending.delete(run.run_id);
      return { action: "skip", reason: judged.reason };
    }

    const state = this.byRun.get(run.run_id) ?? newNudgeState(Boolean(run.associated));
    // A run that cannot send now must not hold the fairness turn of the current window.
    if (state.paused || state.stalled) {
      this.bgPending.delete(run.run_id);
      return { action: "skip", reason: state.paused ? "paused" : "stalled" };
    }

    if (state.versionAtLastNudge === run.version && state.consecutiveWithoutProgress >= maxStreak) {
      state.stalled = true;
      this.byRun.set(run.run_id, state);
      this.bgPending.delete(run.run_id);
      const notify = `KEEL：run ${run.run_id} 连续 ${maxStreak} 次叫醒无进展，已停推并开人工门。`;
      await this.ports.notifyUser(notify);
      return { action: "stall", reason: "no_progress", notify, stalled: true };
    }

    const prompt = nudgePrompt(run.run_id);
    const useCard = this.config.cardOnly || !state.associated;
    this.byRun.set(run.run_id, state);

    if (useCard) {
      this.bgPending.delete(run.run_id);
      // A card waits for the user's click: show it once per run version, not once per tick.
      if (state.cardShownVersion === run.version && state.cardShownAt !== null) {
        return { action: "skip", reason: "card_interval" };
      }
      const card = renderNudgeCard(run.run_id);
      state.cardShownAt = now;
      state.cardShownVersion = run.version;
      this.byRun.set(run.run_id, state);
      await this.ports.presentCard(card);
      return { action: "card", reason: this.config.cardOnly ? "card_only" : "unassociated", prompt, card };
    }

    const pending = this.bgPending.get(run.run_id) ?? { lastAttemptAt: null, lastSeenEpoch: this.epoch };
    pending.lastSeenEpoch = this.epoch;
    this.bgPending.set(run.run_id, pending);
    if (this.pluginInFlight) return { action: "skip", reason: "busy" };
    if (this.pluginLastSentAt !== null && now - this.pluginLastSentAt < intervalMs) return { action: "skip", reason: "interval" };
    const turn = this.fairestPending();
    if (turn !== undefined && turn !== run.run_id) return { action: "skip", reason: "fairness" };

    this.pluginInFlight = true;
    this.pluginLastSentAt = now;
    this.epoch += 1;
    pending.lastAttemptAt = now;

    try {
      const r = await this.ports.continueSession({
        mode: "continue",
        trigger: "background",
        ...(run.session_id ? { sessionId: run.session_id } : {}),
        promptTemplate: NUDGE_PROMPT_TEMPLATE,
        userMessage: prompt,
        event: { runId: run.run_id },
      });
      state.lastHostStatus = r.status;
      state.lastHostError = r.ok ? undefined : (r.errorCode ?? r.message);
      if (!r.ok && isUnassociated(r.errorCode, r.message)) {
        state.associated = false;
        this.bgPending.delete(run.run_id);
        const card = renderNudgeCard(run.run_id, "关联已丢失");
        await this.ports.presentCard(card);
        return { action: "card", reason: "association_lost", prompt, card };
      }
      if (!r.ok) {
        // RATE_LIMITED / BUSY / other host refusals: not no-progress.
        return { action: "skip", reason: r.errorCode ?? "continue_failed" };
      }
      state.consecutiveWithoutProgress = state.versionAtLastNudge === run.version ? state.consecutiveWithoutProgress + 1 : 1;
      state.versionAtLastNudge = run.version;
      return { action: "continue", reason: judged.reason, prompt };
    } finally {
      this.pluginInFlight = false;
      this.byRun.set(run.run_id, state);
    }
  }
}
