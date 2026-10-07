// Association card for background continue. Cindy issues userActionToken on
// card-action; KEEL forwards it to cindy.agent.run and never validates it itself.

export const ENABLE_AUTOPILOT = "enable_autopilot";
export const PAUSE_RUN = "pause";

export interface CardButton {
  readonly id: string;
  readonly label: string;
}

export interface NudgeCard {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly run_id: string;
  readonly buttons: readonly CardButton[];
}

/** Host card-action payload (Cindy §4.5 / §4.11). Token is host-issued. */
export interface CardActionEvent {
  readonly actionId: string;
  readonly userActionToken?: string;
  readonly callId?: string;
  readonly run_id?: string;
  readonly cardId?: string;
}

export function renderNudgeCard(runId: string, reason = "未完成"): NudgeCard {
  return {
    id: `keel-nudge-${runId}`,
    title: "KEEL",
    body: `run ${runId} ${reason}。点「启用自动续跑」后，空闲超时会叫醒主控；Cindy 重启后需要再点一次。`,
    run_id: runId,
    buttons: [
      { id: ENABLE_AUTOPILOT, label: "启用自动续跑" },
      { id: PAUSE_RUN, label: "暂停" },
    ],
  };
}

function runIdFromNudgeId(id?: string): string | undefined {
  const m = /^keel-nudge-(.+)$/.exec(id ?? "");
  return m?.[1];
}

export function runIdFromCardAction(ev: CardActionEvent): string | undefined {
  if (ev.run_id) return ev.run_id;
  return runIdFromNudgeId(ev.cardId) ?? runIdFromNudgeId(ev.callId);
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** §4.5: buttons are data-ghost-action, zero scripts. */
export function nudgeCardHtml(card: NudgeCard): string {
  const buttons = card.buttons.map((b) => `<button data-ghost-action="${esc(b.id)}">${esc(b.label)}</button>`).join("");
  return `<div style="padding:12px"><p>${esc(card.body)}</p><div>${buttons}</div></div>`;
}

export function cardUpdateMessage(card: NudgeCard, callId: string): { type: "card-update"; callId: string; v: 2; html: string; height: number } {
  return { type: "card-update", callId, v: 2, html: nudgeCardHtml(card), height: 180 };
}

/** Handbook §4.5 first; legacy {type:"card-action"} still accepted. */
export function parseCardActionEvent(msg: any): CardActionEvent | null {
  const handbook = msg?.type === "event" && msg.name === "card-action";
  const legacy = msg?.type === "card-action";
  if (!handbook && !legacy) return null;
  const d = msg.data && typeof msg.data === "object" ? msg.data : {};
  const pick = (k: string) => msg[k] ?? d[k];
  const actionId = String(pick("actionId") ?? pick("action_id") ?? "");
  if (!actionId && !handbook && !legacy) return null;
  return {
    actionId,
    ...(typeof pick("userActionToken") === "string" ? { userActionToken: pick("userActionToken") } : {}),
    ...(typeof pick("callId") === "string" ? { callId: pick("callId") } : {}),
    ...(typeof pick("run_id") === "string" ? { run_id: pick("run_id") } : typeof pick("runId") === "string" ? { run_id: pick("runId") } : {}),
    ...(typeof pick("cardId") === "string" ? { cardId: pick("cardId") } : {}),
  };
}

/** Handbook §4.6: {type:"event", name:"did-turn-end", data:{endReason}}. */
export function parseTurnEndEvent(msg: any): { endReason: "completed" | "interrupted" | "error" } | null {
  const handbook = msg?.type === "event" && msg.name === "did-turn-end";
  const legacy = msg?.type === "did-turn-end" || msg?.topic === "turn";
  if (!handbook && !legacy) return null;
  const d = msg.data && typeof msg.data === "object" ? msg.data : {};
  const raw = handbook ? (d.endReason ?? msg.endReason) : (msg.endReason ?? d.endReason);
  const endReason = raw === "interrupted" || raw === "error" ? raw : "completed";
  return { endReason };
}
