// Graph-side PR facts: Node pr/snapshot + raw threads. Never calls judge / judgeItems,
// and never goes through prWait's trailing status() (which defaults jev:true).

import { allowedActions } from "../../shared/lanes.ts";
import type { PrAction, PrStatus } from "../../shared/types.ts";
import { node, type ToolContext } from "../context.ts";
import { readHandoff } from "../handoff.ts";
import { isMergeable } from "../tools/pr.ts";

type Snapshot = Omit<PrStatus, "handedOff" | "allowedActions" | "nextAction">;

function prArgs(args: Record<string, unknown>) {
  return {
    ...(typeof args.repo_dir === "string" ? { repo_dir: args.repo_dir } : {}),
    ...(typeof args.repo === "string" ? { repo: args.repo } : {}),
    ...(typeof args.pr === "number" ? { pr: args.pr } : typeof args.pr === "string" && /^\d+$/.test(args.pr) ? { pr: Number(args.pr) } : {}),
  };
}

export interface PrThread {
  readonly id: string;
  readonly author: string | null;
  readonly path: string | null;
  readonly line: number | null;
  readonly body: string;
  readonly is_bot: boolean;
}

export interface PrFacts {
  readonly snapshot: Snapshot;
  readonly threads: readonly PrThread[];
  readonly handedOff: boolean;
  readonly allowedActions: readonly PrAction[];
  readonly nextAction: PrAction;
  readonly mergeable: boolean;
}

export async function readPrFacts(ctx: ToolContext, args: Record<string, unknown>): Promise<PrFacts> {
  const snap = await node<Snapshot>(ctx, "pr/snapshot", prArgs(args));
  const raw = await node<{ threads?: PrThread[] }>(ctx, "pr/threads", prArgs(args));
  const handedOff = Boolean(await readHandoff(ctx.host, snap.pr.repo, snap.pr.number));
  const allowed = allowedActions({
    rule: snap.rule,
    decision: snap.decision.kind,
    ...(snap.decision.blocker ? { blocker: snap.decision.blocker } : {}),
    isDraft: snap.pr.isDraft,
    gate: snap.gate,
    handedOff,
    ...(snap.verification ? { verified: snap.verification.state === "pass" } : {}),
  });
  return {
    snapshot: snap,
    threads: raw.threads ?? [],
    handedOff,
    allowedActions: allowed,
    nextAction: allowed[0]!,
    mergeable: isMergeable(snap),
  };
}
