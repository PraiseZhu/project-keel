import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { resolveLane } from "../../shared/lanes.ts";
import type { KeelProfile, VigilHandoffState, VigilReceipt } from "../../shared/types.ts";
import { resolveTool, runRaw, ToolError } from "../env.ts";

const equal = (a: unknown, b: unknown): boolean => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const sha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{40}$/i.test(v);

function helper(profile: KeelProfile, repo: string): string | null {
  const { match, rule } = resolveLane(profile, repo);
  if (match?.handoffHelperPath === undefined) return null;
  const p = match.handoffHelperPath;
  if (rule.postReadyOwner !== "automation" || typeof p !== "string" || !isAbsolute(p) || !p.endsWith(".mjs") || !existsSync(p) || !statSync(p).isFile())
    throw new ToolError("HANDOFF_HELPER_INVALID", "该车道配置的 Vigil 交接 helper 不可用；未交接。");
  return p;
}

async function call(file: string, command: "inspect" | "handoff", repo: string, number: number, head?: string): Promise<any> {
  const args = [file, command, "--repo", repo, "--pr", String(number), ...(head ? ["--expected-head", head] : [])];
  // Cindy's process.execPath is Electron; external helpers require a real Node CLI.
  const result = await runRaw(await resolveTool("node"), args, { timeoutMs: 90_000, maxBuffer: 1024 * 1024 });
  if (result.code !== 0) throw new ToolError("HANDOFF_HELPER_FAILED", `Vigil ${command} 未确认成功，未将作者交接标为完成。`);
  try { return JSON.parse(result.stdout); }
  catch { throw new ToolError("HANDOFF_HELPER_INVALID", "Vigil helper 返回的不是有效 JSON，未交接。"); }
}

function validReceipt(value: any, repo: string, number: number): value is VigilReceipt {
  return value?.version === 1 && typeof value.id === "string" && value.id.length > 0
    && equal(value.repo, repo) && value.number === number && typeof value.nodeId === "string" && value.nodeId.length > 0
    && sha(value.head) && typeof value.releaseEpoch === "string" && value.releaseEpoch.length > 0
    && typeof value.author === "string" && value.author.length > 0;
}

export async function inspectVigil(profile: KeelProfile, repo: string, number: number): Promise<VigilHandoffState | null> {
  const file = helper(profile, repo);
  if (!file) return null;
  const result = await call(file, "inspect", repo, number), pr = result?.pr;
  if (!pr || !equal(pr.repo, repo) || pr.number !== number || typeof pr.id !== "string" || !pr.id
    || !sha(pr.headRefOid) || typeof pr.isDraft !== "boolean" || typeof pr.sameRepository !== "boolean"
    || !["OPEN", "CLOSED", "MERGED"].includes(pr.state) || typeof pr.releaseEpoch !== "string" || !pr.releaseEpoch
    || typeof pr.author?.login !== "string" || !pr.author.login || typeof result.authorAuthorized !== "boolean")
    throw new ToolError("HANDOFF_HELPER_INVALID", "Vigil 归属响应与目标 PR 不匹配。");
  const receipt = result.receipt;
  if (receipt !== null && (!validReceipt(receipt, repo, number) || receipt.nodeId !== pr.id
    || receipt.releaseEpoch !== pr.releaseEpoch || !equal(receipt.author, pr.author.login)))
    throw new ToolError("HANDOFF_HELPER_INVALID", "Vigil 交接回执与当前归属不匹配。");
  const expected = pr.state !== "OPEN" || !pr.sameRepository ? "inactive" : pr.isDraft ? "author-owned" : receipt ? "handed-off" : "ready-unclaimed";
  if (result.status !== expected || ((pr.isDraft || expected === "inactive") && receipt !== null))
    throw new ToolError("HANDOFF_HELPER_INVALID", "Vigil 交接状态与当前 PR 状态不一致。");
  return result as VigilHandoffState;
}

export async function publishVigil(profile: KeelProfile, repo: string, number: number, head: string): Promise<VigilReceipt | null> {
  const file = helper(profile, repo);
  if (!file) return null;
  const result = await call(file, "handoff", repo, number, head);
  if (!["handed-off", "already-handed-off"].includes(result?.status) || !validReceipt(result?.receipt, repo, number)
    || !equal(result.receipt.head, head)) throw new ToolError("HANDOFF_HELPER_INVALID", "Vigil 未返回绑定已验收 HEAD 的交接回执。");
  return result.receipt;
}
