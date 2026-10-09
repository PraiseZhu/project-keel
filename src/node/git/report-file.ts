import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
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
  // The path check is lexical; a symlinked .keel or report file would still escape it.
  let keelDir;
  try {
    keelDir = lstatSync(dirname(path));
  } catch {
    throw new ToolError("REPORT_NOT_FOUND", `找不到报告 ${path}。`);
  }
  if (keelDir.isSymbolicLink() || !keelDir.isDirectory()) throw new ToolError("INVALID_INPUT", "worktree/.keel 必须是真实目录，不能是符号链接。");
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ELOOP" || code === "EMLINK") throw new ToolError("INVALID_INPUT", "报告文件不能是符号链接。");
    throw new ToolError("REPORT_NOT_FOUND", `找不到报告 ${path}。`);
  }
  try {
    if (!fstatSync(fd).isFile()) throw new ToolError("INVALID_INPUT", "报告必须是普通文件。");
    return { path, content: readFileSync(fd, "utf8") };
  } finally {
    closeSync(fd);
  }
}
