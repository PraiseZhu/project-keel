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

export function runIdFromCardAction(ev: CardActionEvent): string | undefined {
  if (ev.run_id) return ev.run_id;
  const m = /^keel-nudge-(.+)$/.exec(ev.cardId ?? "");
  return m?.[1];
}
