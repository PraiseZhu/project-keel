// `jev`: everyday Jev, independent of PR work. No repo access, no Node, no PR ledger;
// one Typesafe call plus one line in the daily jev log.

import { evaluate, listModels, type EvaluateArgs } from "../jev/client.ts";
import { fromShorthand, isShorthand, summarise, type Shorthand } from "../jev/shorthand.ts";
import type { ToolContext } from "../context.ts";
import { sha256 } from "../ledger.ts";

export async function jevTool(ctx: ToolContext, args: Record<string, unknown>) {
  if (args.list_models === true) return listModels(ctx.host, ctx.callId);
  const req: EvaluateArgs = isShorthand(args) ? fromShorthand(args as unknown as Shorthand) : (args as unknown as EvaluateArgs);
  const result = await evaluate(ctx.host, req, ctx.callId);
  const { summary, confidence_hint } = summarise(result, ctx.thresholds.act);
  await logDaily(ctx, req, result.answers).catch(() => undefined);
  return { model: result.model, answers: result.answers, usage: result.usage, summary, confidence_hint };
}

async function logDaily(ctx: ToolContext, req: EvaluateArgs, answers: unknown) {
  const day = new Date(ctx.host.now()).toISOString().slice(0, 10);
  const path = `jev/${day}.jsonl`;
  const prev = await ctx.host.fs({ op: "read", root: "data", path });
  const line = JSON.stringify({ at: new Date(ctx.host.now()).toISOString(), state_sha256: await sha256(req.state), questions: Object.keys(req.questions), answers });
  await ctx.host.fs({ op: "write", root: "data", path, content: (prev.ok ? prev.content ?? "" : "") + line + "\n" });
}
