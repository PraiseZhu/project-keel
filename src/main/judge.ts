// Run one or more J-templates in a single Typesafe call, apply the threshold policy,
// and write a ledger row per template. Jev failure never throws here: callers get
// `jev:null` plus the policy's fallback so deterministic routing can continue.

import { evaluate, type EvaluateArgs } from "./jev/client.ts";
import { decide, type PolicyResult } from "./jev/policy.ts";
import { template, type Interpretation, type TemplateId } from "./jev/templates.ts";
import { KeelError } from "./host.ts";
import type { ToolContext } from "./context.ts";
import { append, sha256 } from "./ledger.ts";

export interface Judgement {
  readonly template: TemplateId;
  readonly interpretation: Interpretation | null;
  readonly policy: PolicyResult;
  readonly ledger_row?: string;
}

export interface JudgeOutcome {
  readonly judgements: Judgement[];
  readonly answers: Record<string, unknown> | null;
  readonly fallback_reason?: string;
  readonly error_code?: string;
}

export async function judge(ctx: ToolContext, specs: { id: TemplateId; state: Record<string, unknown>; options?: readonly string[] }[], opts: { runId?: string; reasked?: boolean } = {}): Promise<JudgeOutcome> {
  const built = specs.map((s) => {
    const t = template(s.id);
    if (!t) throw new KeelError("INVALID_INPUT", `未知判断模板 ${s.id}，可用 J1–J12。`);
    return { spec: s, t, args: t.build(s.state, s.options) };
  });
  // Merge questions (ids are template-scoped already) into one request.
  const merged: EvaluateArgs = {
    state: specs.length === 1 ? built[0]!.args.state : Object.fromEntries(built.map((b) => [b.spec.id, b.args.state])),
    questions: Object.assign({}, ...built.map((b) => b.args.questions)),
  };
  let answers: Record<string, any> | null = null;
  let fallback: string | undefined;
  let errorCode: string | undefined;
  try {
    answers = (await evaluate(ctx.host, merged, ctx.callId)).answers;
  } catch (e) {
    errorCode = e instanceof KeelError ? e.code : "REQUEST_FAILED";
    fallback = `${errorCode}: ${e instanceof Error ? e.message : String(e)}`;
  }
  const judgements: Judgement[] = [];
  for (const b of built) {
    const own = answers ? Object.fromEntries(Object.keys(b.args.questions).map((k) => [k, answers![k]])) : null;
    const interpretation = own ? b.t.interpret(own) : null;
    const policy = decide({ template: b.t, interpretation, alreadyReasked: Boolean(opts.reasked), thresholds: ctx.thresholds });
    let ledger_row: string | undefined;
    if (opts.runId) {
      const row = await append(ctx.host, {
        run_id: opts.runId, kind: "decision", summary: `${b.t.id} ${b.t.title}：${policy.action} ${String(policy.value)}`,
        template: b.t.id, state_sha256: await sha256(b.spec.state), ...(b.spec.options ? { options: b.spec.options } : {}),
        answer: interpretation?.value ?? null, confidence: interpretation?.confidence ?? 0, policy: policy.action,
      });
      ledger_row = row.row_id;
    }
    judgements.push({ template: b.t.id, interpretation, policy, ...(ledger_row ? { ledger_row } : {}) });
  }
  return { judgements, answers, ...(fallback ? { fallback_reason: fallback } : {}), ...(errorCode ? { error_code: errorCode } : {}) };
}
