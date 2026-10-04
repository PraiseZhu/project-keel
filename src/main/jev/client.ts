// Typesafe Jev client. Request validation, response validation and error codes are
// ported from the typesafe-jev plugin so `keel/jev` is a drop-in for `typesafe-jev/evaluate`.

import { KeelError, type Host } from "../host.ts";

export type QuestionType = "choice" | "score" | "noul";

export interface JevQuestion {
  readonly type: QuestionType;
  readonly instructions: unknown;
  readonly criteria?: unknown;
}

export interface EvaluateArgs {
  readonly state: unknown;
  readonly questions: Record<string, JevQuestion>;
  readonly model?: string;
}

export interface JevAnswer {
  readonly type: QuestionType;
  readonly choice?: string;
  readonly score?: number;
  readonly noul?: number;
  readonly confidence?: number;
  readonly probabilities?: Record<string, number>;
  readonly legend?: Record<string, unknown>;
}

export interface EvaluateResult {
  readonly model: string;
  readonly answers: Record<string, JevAnswer>;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
}

export const JEV_API = "https://api.typesafe.ai/v1/";
export const MAX_BODY_BYTES = 256 * 1024;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const structured = (v: unknown): boolean => typeof v === "string" || (v !== null && typeof v === "object");
const probability = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

const INVALID = "请检查 state、questions、criteria 和 model；请求不得超过 256 KB。";

export function toRequestBody(args: Partial<EvaluateArgs>): string {
  const bad = (): never => {
    throw new KeelError("INVALID_INPUT", INVALID);
  };
  if (!structured(args.state) || !isObject(args.questions) || !Object.keys(args.questions).length) bad();
  if (args.model !== undefined && (typeof args.model !== "string" || !/^jev-[a-zA-Z0-9.-]+$/.test(args.model))) bad();
  const questions: Record<string, JevQuestion> = Object.create(null);
  for (const [id, q] of Object.entries(args.questions as Record<string, unknown>)) {
    if (!isObject(q) || !structured(q.instructions) || !["choice", "score", "noul"].includes(q.type as string)) bad();
    const qq = q as Record<string, unknown>;
    const c = qq.criteria;
    if (qq.type === "choice" && (!isObject(c) || Object.keys(c).length < 1 || Object.keys(c).length > 255 || !Object.values(c).every((v) => v === null || structured(v)))) bad();
    if (qq.type === "score" && (!Array.isArray(c) || c.length < 2 || c.length > 10 || !c.every(structured))) bad();
    if (qq.type === "noul" && c !== undefined && (!isObject(c) || Object.keys(c).some((k) => !["true", "false"].includes(k)) || !Object.values(c).every(structured))) bad();
    questions[id] = { type: qq.type as QuestionType, instructions: qq.instructions, ...(c === undefined ? {} : { criteria: c }) };
  }
  const body = JSON.stringify({ model: args.model || "jev-latest", state: args.state, questions });
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) throw new KeelError("INPUT_TOO_LARGE", INVALID);
  return body;
}

export function validAnswers(data: Record<string, unknown>, questions: Record<string, JevQuestion>): boolean {
  const usage = data.usage as Record<string, unknown> | undefined;
  if (typeof data.model !== "string" || !isObject(usage) || !Number.isInteger(usage.input_tokens) || (usage.input_tokens as number) < 0 || !Number.isInteger(usage.output_tokens) || (usage.output_tokens as number) < 0) return false;
  const answers = data.answers as Record<string, unknown>;
  return Object.entries(questions).every(([id, q]) => {
    const a = answers[id];
    if (!isObject(a) || a.type !== q.type) return false;
    if (q.type === "noul") return probability(a.noul);
    if (!isObject(a.probabilities) || !Object.keys(a.probabilities).length || !Object.values(a.probabilities).every(probability) || !probability(a.confidence)) return false;
    if (q.type === "choice") return typeof a.choice === "string" && Object.prototype.hasOwnProperty.call(q.criteria, a.choice);
    return typeof a.score === "number" && Number.isFinite(a.score) && a.score >= 0 && a.score <= (q.criteria as unknown[]).length - 1 && isObject(a.legend);
  });
}

export interface JevConfig {
  /** Set by index.ts from the secret-status probe; false short-circuits with JEV_NOT_CONFIGURED. */
  readonly configured?: () => Promise<boolean>;
}

export async function evaluate(host: Host, args: Partial<EvaluateArgs>, callId?: string, config: JevConfig = {}): Promise<EvaluateResult> {
  const body = toRequestBody(args);
  if (config.configured && !(await config.configured()))
    throw new KeelError("JEV_NOT_CONFIGURED", "还没有填写 Typesafe API Key。请在 Keel 插件详情页的设置区填写后重试。");
  const r = await request(host, "systemone", body, callId);
  const data = parse(r);
  const questions = (args.questions ?? {}) as Record<string, JevQuestion>;
  if (!isObject(data.answers) || Object.keys(questions).some((k) => !Object.prototype.hasOwnProperty.call(data.answers, k)) || !validAnswers(data, questions))
    throw new KeelError("INVALID_RESPONSE", "Typesafe 响应结构不完整，请稍后重试。");
  return { model: data.model as string, answers: data.answers as Record<string, JevAnswer>, usage: data.usage as EvaluateResult["usage"] };
}

export async function listModels(host: Host, callId?: string): Promise<{ models: unknown[] }> {
  const data = parse(await request(host, "models", undefined, callId));
  if (!Array.isArray(data.models)) throw new KeelError("INVALID_RESPONSE", "Typesafe 响应结构不完整，请稍后重试。");
  return { models: data.models };
}

async function request(host: Host, path: string, body: string | undefined, callId?: string) {
  let r;
  try {
    r = await host.fetch({
      url: JEV_API + path,
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      ...(body === undefined ? {} : { body }),
      timeoutMs: 60000,
      ...(callId ? { callId } : {}),
    });
  } catch {
    throw new KeelError("REQUEST_FAILED", "请求未完成，请检查网络或稍后重试。");
  }
  if (!r.ok && /凭证|credential|secret|api[_ ]?key/i.test(`${r.message ?? ""} ${r.errorCode ?? ""}`))
    // The host message already says where to fill the key; relay it instead of adding a second instruction.
    throw new KeelError("JEV_NOT_CONFIGURED", r.message || "还没有可用的 Typesafe API Key。请在 Keel 插件详情页的设置区填写后重试。");
  if (!r.ok) throw new KeelError("NETWORK_ERROR", "连接 Typesafe 失败。请检查网络以及插件详情页的 API Key 配置后重试。");
  if (r.status < 200 || r.status >= 300) {
    const hint = [401, 403].includes(r.status) ? "请检查 API Key 和账号使用资格。" : [429, 529].includes(r.status) ? "服务限流或繁忙，请稍后重试。" : "请检查请求参数或稍后重试。";
    throw new KeelError("UPSTREAM_HTTP_ERROR", `Typesafe HTTP ${r.status}。${hint}`, { status: r.status });
  }
  if (r.truncated) throw new KeelError("INVALID_RESPONSE", "响应被截断，请缩小问题数量后重试。");
  return r;
}

function parse(r: { body: string }): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(r.body);
  } catch {
    throw new KeelError("INVALID_RESPONSE", "Typesafe 响应结构不完整，请稍后重试。");
  }
  if (!isObject(data)) throw new KeelError("INVALID_RESPONSE", "Typesafe 响应结构不完整，请稍后重试。");
  return data;
}

/** Confidence of one answer: choice/score use `confidence`; noul uses the stronger side. */
export function answerConfidence(a: JevAnswer): number {
  if (a.type === "noul") return Math.max(a.noul ?? 0, 1 - (a.noul ?? 0));
  return a.confidence ?? 0;
}
