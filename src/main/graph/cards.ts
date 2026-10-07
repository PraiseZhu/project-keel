// Association card for background continue. Tokens are user-click only:
// two minutes, one use, never from a background path.

export const ENABLE_AUTOPILOT = "enable_autopilot";
export const PAUSE_RUN = "pause";
export const TOKEN_TTL_MS = 2 * 60_000;

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

export interface ActionToken {
  readonly token: string;
  readonly run_id: string;
  readonly issued_at: number;
  used: boolean;
}

export interface TokenBook {
  readonly byToken: Map<string, ActionToken>;
}

export function newTokenBook(): TokenBook {
  return { byToken: new Map() };
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

export function issueUserActionToken(book: TokenBook, runId: string, now: number, token = `uat-${now}-${Math.random().toString(16).slice(2, 10)}`): ActionToken {
  const rec: ActionToken = { token, run_id: runId, issued_at: now, used: false };
  book.byToken.set(token, rec);
  return rec;
}

export function consumeUserActionToken(
  book: TokenBook,
  token: string | undefined,
  now: number,
  opts: { run_id: string; background?: boolean },
): { ok: true } | { ok: false; error: string } {
  if (opts.background) return { ok: false, error: "userActionToken 不能在后台复用" };
  if (!token) return { ok: false, error: "缺少 userActionToken" };
  const rec = book.byToken.get(token);
  if (!rec || rec.run_id !== opts.run_id) return { ok: false, error: "userActionToken 无效" };
  if (rec.used) return { ok: false, error: "userActionToken 已使用" };
  if (now - rec.issued_at > TOKEN_TTL_MS) return { ok: false, error: "userActionToken 已过期" };
  rec.used = true;
  return { ok: true };
}

export type CardActionResult =
  | { ok: true; action: "associate"; run_id: string }
  | { ok: true; action: "pause"; run_id: string }
  | { ok: false; error: string };

export function handleCardAction(
  book: TokenBook,
  input: { action: string; token?: string; background?: boolean; run_id: string; now: number },
): CardActionResult {
  const used = consumeUserActionToken(book, input.token, input.now, { run_id: input.run_id, background: input.background });
  if (!used.ok) return used;
  if (input.action === ENABLE_AUTOPILOT) return { ok: true, action: "associate", run_id: input.run_id };
  if (input.action === PAUSE_RUN) return { ok: true, action: "pause", run_id: input.run_id };
  return { ok: false, error: `未知卡片动作 ${input.action}` };
}
