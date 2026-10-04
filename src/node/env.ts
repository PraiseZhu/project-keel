// Process helpers for the Cindy Node worker.
//
// Cindy hands plugin workers a trimmed environment (PATH/TMPDIR/LANG, no HOME).
// `gh` needs HOME to find ~/.config/gh, and GUI-launched PATHs often miss
// Homebrew, so we restore both. Every call uses execFile with an argv array;
// nothing is ever passed through a shell.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, join } from "node:path";

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly killed: boolean;
  readonly missing: boolean;
}

export interface RunOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly input?: string;
  readonly maxBuffer?: number;
}

const EXTRA_PATHS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

const toolCache = new Map<string, string>();

export function toolEnv(): NodeJS.ProcessEnv {
  const merged = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const resolved of toolCache.values()) {
    const dir = dirname(resolved);
    if (resolved.includes("/") && !merged.includes(dir)) merged.unshift(dir);
  }
  for (const dir of EXTRA_PATHS) if (!merged.includes(dir)) merged.push(dir);
  let user = "";
  try {
    user = userInfo().username;
  } catch {
    user = "";
  }
  return {
    ...process.env,
    HOME: process.env.HOME || homedir(),
    PATH: merged.join(delimiter),
    GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0",
    NO_COLOR: "1",
    ...(user ? { USER: user, LOGNAME: user } : {}),
  };
}

export function runRaw(file: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 60_000,
        maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
        windowsHide: true,
        env: toolEnv(),
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
        resolve({
          code,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          killed: Boolean(error && (error as { killed?: boolean }).killed),
          missing: Boolean(error && (error as { code?: unknown }).code === "ENOENT"),
        });
      },
    );
    if (options.input !== undefined && child.stdin) {
      child.stdin.end(options.input);
    }
  });
}

function candidates(tool: string): string[] {
  const home = homedir();
  return [
    `/opt/homebrew/bin/${tool}`,
    `/usr/local/bin/${tool}`,
    `/usr/bin/${tool}`,
    `/opt/local/bin/${tool}`,
    join(home, ".local", "bin", tool),
    join(home, "bin", tool),
  ];
}

export class ToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export async function resolveTool(tool: "gh" | "git"): Promise<string> {
  const cached = toolCache.get(tool);
  if (cached) return cached;
  const probe = await runRaw(tool, ["--version"], { timeoutMs: 15_000 });
  if (probe.code === 0) {
    toolCache.set(tool, tool);
    return tool;
  }
  for (const candidate of candidates(tool)) {
    if (!existsSync(candidate)) continue;
    const hit = await runRaw(candidate, ["--version"], { timeoutMs: 15_000 });
    if (hit.code === 0) {
      toolCache.set(tool, candidate);
      return candidate;
    }
  }
  for (const shell of ["/bin/zsh", "/bin/bash"]) {
    if (!existsSync(shell)) continue;
    const found = await runRaw(shell, ["-lc", `command -v ${tool}`], { timeoutMs: 20_000 });
    const line = found.stdout.trim().split("\n").filter(Boolean).pop();
    if (found.code === 0 && line && existsSync(line)) {
      toolCache.set(tool, line);
      return line;
    }
  }
  throw new ToolError(
    "TOOL_NOT_FOUND",
    tool === "gh"
      ? "这台电脑上找不到 gh。请安装 GitHub CLI（brew install gh）并执行 gh auth login 后重试。"
      : "这台电脑上找不到 git。请安装 git 后重试。",
  );
}

function explain(tool: string, args: readonly string[], res: RunResult): string {
  const detail = (res.stderr || res.stdout).trim().split("\n").slice(0, 6).join(" ");
  if (res.killed) return `${tool} ${args[0] ?? ""} 执行超时，可能是网络较慢，请稍后重试。`;
  if (/gh auth login|GH_TOKEN|authentication token/i.test(detail))
    return "本机 gh 读不到 GitHub 登录。请在终端执行 gh auth login 后重试。";
  if (/keychain|keyring|user interaction is not allowed/i.test(detail))
    return "gh 读取钥匙串凭证被系统拦下。若弹出“允许访问”请点允许，然后重试。";
  return `${tool} ${args.slice(0, 3).join(" ")} 失败（退出码 ${res.code}）：${detail || "无输出"}`;
}

export async function gh(args: readonly string[], options: RunOptions = {}): Promise<string> {
  const bin = await resolveTool("gh");
  const res = await runRaw(bin, args, options);
  if (res.code !== 0) throw new ToolError("GH_ERROR", explain("gh", args, res));
  return res.stdout;
}

export async function ghRaw(args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const bin = await resolveTool("gh");
  return runRaw(bin, args, options);
}

export async function git(args: readonly string[], options: RunOptions = {}): Promise<string> {
  const bin = await resolveTool("git");
  const res = await runRaw(bin, args, options);
  if (res.code !== 0) throw new ToolError("GIT_ERROR", explain("git", args, res));
  return res.stdout;
}

export async function gitRaw(args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const bin = await resolveTool("git");
  return runRaw(bin, args, options);
}

export async function ghJson<T = unknown>(args: readonly string[], options: RunOptions = {}): Promise<T> {
  const out = await gh(args, options);
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new ToolError("GH_ERROR", `gh ${args.slice(0, 3).join(" ")} 返回的不是 JSON。`);
  }
}
