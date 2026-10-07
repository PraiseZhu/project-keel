// Persist verifier verdicts into orch ledger (PR+SHA) and optional lane verifyCheck.
// Graph-state still holds the extra evidence; GitHub's hard gate reads the status.

import { resolveLane } from "../../shared/lanes.ts";
import { node, type ToolContext } from "../context.ts";
import { KeelError } from "../host.ts";
import type { GraphRunState } from "./state.ts";
import { levelMeets, type GraphVerdict } from "./verdict.ts";

export function orchStorePath(state: Pick<GraphRunState, "worktree" | "repo_root" | "invocation_dir">): string | undefined {
  for (const root of [state.worktree, state.repo_root, state.invocation_dir]) {
    if (typeof root === "string" && root.startsWith("/") && !root.includes("\0")) {
      return `${root.replace(/\/+$/, "")}/.keel/orch`;
    }
  }
}

function errorText(e: unknown): string {
  if (e instanceof KeelError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

function prNumber(state: GraphRunState, verdict?: GraphVerdict): number | undefined {
  const raw = verdict?.pr ?? state.pr ?? state.pr_binding?.number;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function orch(ctx: ToolContext, store: string, op: string, args?: Record<string, unknown>): Promise<unknown> {
  return node(ctx, "orch/run", { store, op, force: true, ...(args ? { args } : {}) });
}

export async function recordVerifierVerdict(
  ctx: ToolContext,
  state: GraphRunState,
  verdict: GraphVerdict,
): Promise<{ ok: boolean; message?: string }> {
  const store = orchStorePath(state);
  if (!store) return { ok: false, message: "orch store 路径未知，无法写入 ledger" };
  const pr = prNumber(state, verdict);
  if (!pr) return { ok: false, message: "verdict 没有合法 PR 号，无法写入 ledger" };
  if (!verdict.head_sha) return { ok: false, message: "verdict 没有 head SHA，无法写入 ledger" };
  const evidence = `patch_id=${verdict.patch_id};base_sha=${verdict.base_sha};family=${verdict.by_family};surface=${verdict.surface}`;
  try {
    await orch(ctx, store, "init");
    await orch(ctx, store, "ledger.record", {
      pr,
      sha: verdict.head_sha,
      verdict: verdict.level,
      evidence,
      verifier: verdict.by_route.model,
    });
  } catch (e) {
    return { ok: false, message: `ledger 写入失败：${errorText(e)}` };
  }
  const repo = verdict.repo;
  const check = repo ? resolveLane(ctx.profile, repo).match?.verifyCheck : undefined;
  if (check) {
    const stateName = levelMeets(verdict.level) ? "success" : "failure";
    try {
      await node(ctx, "gh/commit-status", {
        repo,
        sha: verdict.head_sha,
        state: stateName,
        context: check,
        description: `${verdict.by_route.model} ${verdict.level}`.slice(0, 140),
      });
    } catch (e) {
      return { ok: false, message: `verifyCheck 写入失败：${errorText(e)}` };
    }
  }
  return { ok: true };
}

export async function confirmLedgerHead(
  ctx: ToolContext,
  state: GraphRunState,
  headSha: string,
): Promise<{ ok: boolean; missing: string[] }> {
  const store = orchStorePath(state);
  if (!store) return { ok: false, missing: ["orch store 路径未知，无法核对 ledger"] };
  const pr = prNumber(state);
  if (!pr) return { ok: false, missing: ["没有 PR 号，无法核对 ledger"] };
  if (!headSha) return { ok: false, missing: ["没有当前 head，无法核对 ledger"] };
  try {
    await orch(ctx, store, "init");
    const row = await orch(ctx, store, "ledger.check", { pr, sha: headSha }) as { sha?: string } | undefined;
    if (!row || row.sha !== headSha) return { ok: false, missing: ["ledger 没有当前 head 的验证记录"] };
    return { ok: true, missing: [] };
  } catch (e) {
    return { ok: false, missing: [`ledger 核对失败：${errorText(e)}`] };
  }
}
