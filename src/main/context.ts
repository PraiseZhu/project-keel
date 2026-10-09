import { DEFAULT_THRESHOLDS, EMPTY_PROFILE, type JevThresholds, type KeelProfile } from "../shared/types.ts";
import { KeelError, type Host } from "./host.ts";

export interface ToolContext {
  readonly host: Host;
  readonly profile: KeelProfile;
  readonly thresholds: JevThresholds;
  readonly callId: string;
  readonly sessionId?: string;
}

declare const __KEEL_PROFILE__: KeelProfile | undefined;
export const BUILT_PROFILE: KeelProfile = typeof __KEEL_PROFILE__ !== "undefined" ? __KEEL_PROFILE__ : EMPTY_PROFILE;

export function makeContext(host: Host, callId: string, profile: KeelProfile = BUILT_PROFILE, thresholds: JevThresholds = DEFAULT_THRESHOLDS, sessionId?: string): ToolContext {
  return { host, profile, thresholds, callId, ...(sessionId ? { sessionId } : {}) };
}

/** Call the Node worker; turn RPC failures into KeelError with the worker's error code. */
export async function node<T = any>(ctx: ToolContext, method: string, params: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<T> {
  const r = await ctx.host.node(method, { ...params, profile: ctx.profile }, { callId: ctx.callId, timeoutMs });
  if (!r.ok) {
    const { code, message } = splitNodeError(r.message);
    throw new KeelError(code, message);
  }
  return r.result as T;
}

/** Node errors arrive as `CODE: message` (see src/node/rpc.ts). */
export function splitNodeError(m?: string): { code: string; message: string } {
  const hit = (m ?? "").match(/([A-Z][A-Z_]{2,}): ([\s\S]*)$/);
  if (hit && hit[1] !== "INTERNAL") return { code: hit[1]!, message: hit[2]! };
  return { code: "NODE_REQUEST_FAILED", message: hit?.[2] ?? m ?? "本地 Node 工作进程调用失败。" };
}

export function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new KeelError("INVALID_INPUT", `缺少参数 ${key}。`);
  return v;
}
