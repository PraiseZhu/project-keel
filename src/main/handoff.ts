// Post-Ready handoff records. Once a PR in an automation-owned lane is marked Ready, the
// author session must stop pushing, replying or fixing; tools check this record first.

import { KeelError, type Host } from "./host.ts";

export interface HandoffRecord {
  readonly repo: string;
  readonly number: number;
  readonly at: string;
  readonly head_sha: string | null;
  readonly gate: unknown;
  readonly evidence: unknown;
}

const key = (repo: string, n: number) => `handoff/${repo.replace("/", "__").toLowerCase()}__${n}.json`;

export async function readHandoff(host: Host, repo: string, n: number): Promise<HandoffRecord | null> {
  const r = await host.fs({ op: "read", root: "data", path: key(repo, n) });
  return r.ok && r.content ? (JSON.parse(r.content) as HandoffRecord) : null;
}

export async function writeHandoff(host: Host, rec: HandoffRecord): Promise<void> {
  const w = await host.fs({ op: "write", root: "data", path: key(rec.repo, rec.number), content: JSON.stringify(rec, null, 2) });
  if (!w.ok) throw new KeelError("LEDGER_WRITE_FAILED", `交接记录写入失败：${w.message ?? "未知原因"}`);
}

export async function assertNotHandedOff(host: Host, repo: string, n: number): Promise<void> {
  const rec = await readHandoff(host, repo, n);
  if (rec)
    throw new KeelError("LANE_HANDED_OFF", `${repo}#${n} 已于 ${rec.at} 转 Ready 并交接给自动化盯梢。作者会话不再推送、回帖或修复；如需大改，请先按仓库规则把 PR 转回 Draft。`, { handoff: rec });
}
