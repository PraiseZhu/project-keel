import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { ToolError } from "../env.ts";

const NAME = /^[a-z0-9._-]+-\d+\.md$/i;

export function reportFilePath(worktree: string, node: string, attempt: number): string {
  if (!/^[a-z0-9._-]+$/i.test(node)) throw new ToolError("INVALID_INPUT", "node 只能含字母、数字、点、下划线和连字符。");
  if (!Number.isInteger(attempt) || attempt < 0) throw new ToolError("INVALID_INPUT", "attempt 必须是非负整数。");
  const name = `${node}-${attempt}.md`;
  if (!NAME.test(name)) throw new ToolError("INVALID_INPUT", "报告文件名不在白名单内。");
  const root = resolve(worktree);
  const full = resolve(root, ".keel", name);
  const keel = resolve(root, ".keel") + sep;
  if (!full.startsWith(keel)) throw new ToolError("INVALID_INPUT", "报告路径必须在 worktree/.keel/ 下。");
  return full;
}

export function readNodeReportFile(p: { worktree?: string; node?: string; attempt?: number }): { path: string; content: string } {
  if (!p.worktree || !p.node || p.attempt === undefined) throw new ToolError("INVALID_INPUT", "需要 worktree、node、attempt。");
  const path = reportFilePath(p.worktree, p.node, Number(p.attempt));
  try {
    return { path, content: readFileSync(path, "utf8") };
  } catch {
    throw new ToolError("REPORT_NOT_FOUND", `找不到报告 ${path}。`);
  }
}
