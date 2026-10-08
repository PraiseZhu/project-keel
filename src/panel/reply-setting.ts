// Settings page: pr_reply posting mode stored in /kv.replyConfirm ("auto" | "confirm").

import type { SettingsIO } from "./manual-editor.ts";

export type ReplyMode = "auto" | "confirm";

export const REPLY_MODE_LABELS: Record<ReplyMode, string> = {
  auto: "自动发送",
  confirm: "每条确认",
};

export function readReplyMode(kv: Record<string, unknown>): { mode: ReplyMode; error?: string } {
  const v = kv.replyConfirm;
  if (v === undefined) return { mode: "auto" };
  if (v === "auto" || v === "confirm") return { mode: v };
  return { mode: "auto", error: `kv.replyConfirm 值非法（${JSON.stringify(v)}），pr_reply 会报错，请重新选择并保存。` };
}

export async function saveReplyMode(io: SettingsIO, mode: ReplyMode): Promise<{ ok: true } | { ok: false; message: string }> {
  let kv: Record<string, unknown>;
  try {
    kv = await io.getKv();
  } catch (e) {
    return { ok: false, message: `未写入：${e instanceof Error ? e.message : "读取 /kv 失败。"}` };
  }
  const put = await io.putKv({ ...kv, replyConfirm: mode });
  if (!put.ok) return { ok: false, message: put.message ?? `写入 /kv 失败（HTTP ${put.status}）。` };
  return { ok: true };
}
