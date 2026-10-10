// Parse a NodeReport from a .keel markdown file or an inline report body.

import { KeelError } from "../host.ts";

export const NODE_REPORT_STATUSES = ["done", "partial", "blocked", "failed"] as const;
export type NodeReportStatus = (typeof NODE_REPORT_STATUSES)[number];
export const NODE_VERDICTS = ["PASS", "PASS+NOTES", "FAIL"] as const;

export interface NodeReport {
  readonly dispatch_key: string;
  readonly status: NodeReportStatus;
  readonly summary: string;
  readonly branch?: string;
  readonly head_sha?: string;
  readonly files_changed: readonly string[];
  /** Distinct functions the worker actually touched. Missing is unknown, not "did not cross". */
  readonly functions_touched?: readonly string[];
  /** Added+removed lines. Missing means final-review skip is not allowed. */
  readonly changed_lines?: number;
  /** tests_passed: test cases the runner's own summary reports as run and passed (unit evidence needs ≥1). */
  readonly ran: readonly { readonly cmd: string; readonly exit_code: number; readonly tests_passed?: number }[];
  readonly findings?: readonly string[];
  readonly verdict?: (typeof NODE_VERDICTS)[number];
  readonly next_suggestions?: readonly string[];
  /** Worker-supplied live-UI artifacts. Pass through; never invent. */
  readonly ui_evidence?: readonly string[];
  /** Self-reported surface. Can only lower the mapped level. */
  readonly surface?: "live-ui" | "unit-test" | "type-check" | "blocked";
  readonly citation?: string;
  readonly sc_evidence?: Readonly<Record<string, boolean>>;
  readonly body?: string;
}

function extractJson(text: string): { raw: unknown; body: string } {
  const fence = text.match(/```json\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return { raw: JSON.parse(fence[1]!), body: (text.slice(0, fence.index) + text.slice(fence.index! + fence[0].length)).trim() };
    } catch {
      throw new KeelError("REPORT_INVALID", "报告里的 json fence 不是合法 JSON。");
    }
  }
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      return { raw: JSON.parse(trimmed), body: "" };
    } catch {
      throw new KeelError("REPORT_INVALID", "内联报告不是合法 JSON。");
    }
  }
  throw new KeelError("REPORT_INVALID", "报告缺少 NodeReport 的 json fence 或内联 JSON。");
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function parseNodeReport(text: string, expectedDispatchKey: string): NodeReport {
  if (typeof text !== "string" || !text.trim()) throw new KeelError("REPORT_INVALID", "报告是空的。");
  let parsed: { raw: unknown; body: string };
  try {
    parsed = extractJson(text);
  } catch (e) {
    if (e instanceof KeelError) throw e;
    throw new KeelError("REPORT_INVALID", "报告不是合法 JSON。");
  }
  if (!parsed.raw || typeof parsed.raw !== "object" || Array.isArray(parsed.raw)) {
    throw new KeelError("REPORT_INVALID", "NodeReport 必须是对象。");
  }
  const o = parsed.raw as Record<string, unknown>;
  const dispatchKey = str(o.dispatch_key);
  if (!dispatchKey) throw new KeelError("REPORT_INVALID", "缺少 dispatch_key。");
  if (dispatchKey !== expectedDispatchKey) {
    throw new KeelError("DISPATCH_KEY_UNKNOWN", `dispatch_key ${dispatchKey} 不是当前要求的 ${expectedDispatchKey}。`, { dispatch_key: dispatchKey });
  }
  if (typeof o.status !== "string" || !(NODE_REPORT_STATUSES as readonly string[]).includes(o.status)) {
    throw new KeelError("REPORT_INVALID", "status 必须是 done、partial、blocked 或 failed。");
  }
  if (typeof o.summary !== "string") throw new KeelError("REPORT_INVALID", "缺少 summary。");
  if (!Array.isArray(o.files_changed) || o.files_changed.some((x) => typeof x !== "string")) {
    throw new KeelError("REPORT_INVALID", "files_changed 必须是字符串数组。");
  }
  if (!Array.isArray(o.ran) || o.ran.some((x) => !x || typeof x !== "object" || typeof (x as { cmd?: unknown }).cmd !== "string" || typeof (x as { exit_code?: unknown }).exit_code !== "number")) {
    throw new KeelError("REPORT_INVALID", "ran 必须是 {cmd, exit_code} 数组。");
  }
  if (o.verdict != null && (typeof o.verdict !== "string" || !(NODE_VERDICTS as readonly string[]).includes(o.verdict))) {
    throw new KeelError("REPORT_INVALID", "verdict 必须是 PASS、PASS+NOTES 或 FAIL。");
  }
  const ran = (o.ran as { cmd: string; exit_code: number; tests_passed?: unknown }[]).map((x) => ({
    cmd: x.cmd,
    exit_code: x.exit_code,
    ...(Number.isInteger(x.tests_passed) && (x.tests_passed as number) >= 0 ? { tests_passed: x.tests_passed as number } : {}),
  }));
  return {
    dispatch_key: dispatchKey,
    status: o.status as NodeReportStatus,
    summary: o.summary,
    files_changed: o.files_changed as string[],
    ran,
    ...(Array.isArray(o.functions_touched) ? { functions_touched: o.functions_touched.filter((x): x is string => typeof x === "string" && x.trim() !== "") } : {}),
    ...(Number.isInteger(o.changed_lines) && (o.changed_lines as number) >= 0 ? { changed_lines: o.changed_lines as number } : {}),
    ...(str(o.branch) ? { branch: str(o.branch) } : {}),
    ...(str(o.head_sha) ? { head_sha: str(o.head_sha) } : {}),
    ...(Array.isArray(o.findings) ? { findings: o.findings.filter((x): x is string => typeof x === "string") } : {}),
    ...(typeof o.verdict === "string" ? { verdict: o.verdict as NodeReport["verdict"] } : {}),
    ...(Array.isArray(o.next_suggestions) ? { next_suggestions: o.next_suggestions.filter((x): x is string => typeof x === "string") } : {}),
    ...(Array.isArray(o.ui_evidence) ? { ui_evidence: o.ui_evidence.filter((x): x is string => typeof x === "string") } : {}),
    ...(o.surface === "live-ui" || o.surface === "unit-test" || o.surface === "type-check" || o.surface === "blocked" ? { surface: o.surface } : {}),
    ...(str(o.citation) ? { citation: str(o.citation) } : {}),
    ...(scEvidenceOf(o.sc_evidence) ? { sc_evidence: scEvidenceOf(o.sc_evidence) } : {}),
    ...(parsed.body ? { body: parsed.body } : {}),
  };
}

function scEvidenceOf(raw: unknown): Record<string, boolean> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  if (Array.isArray(raw)) {
    const out: Record<string, boolean> = {};
    for (const row of raw) {
      if (row && typeof row === "object" && typeof (row as { id?: unknown }).id === "string") {
        out[(row as { id: string }).id] = (row as { hasEvidence?: unknown }).hasEvidence === true;
      }
    }
    return Object.keys(out).length ? out : undefined;
  }
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = v === true;
  return Object.keys(out).length ? out : undefined;
}
