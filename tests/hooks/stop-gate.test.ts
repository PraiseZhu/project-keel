import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";

// The gate is a classic JXA script; load its pure functions in a fresh context.
const script = fileURLToPath(new URL("../../plugin/hooks/keel-stop-gate.js", import.meta.url));
type Result = { action: "allow"; why?: string } | { action: "block"; run_id: string; current_node: string };
interface Gate {
  parseArgs(argv: string[]): { harness: string; index: string };
  evaluate(event: unknown, index: unknown): Result;
  formatOutput(harness: string, result: { action: string; run_id?: string; current_node?: string }): Record<string, unknown>;
  decide(opts: { harness: string }, stdin: string, indexText: string | null): Record<string, unknown>;
}
const gate = (() => {
  const ctx: Record<string, unknown> = {};
  runInNewContext(readFileSync(script, "utf8"), ctx);
  return ctx as unknown as Gate;
})();
const { evaluate, formatOutput, parseArgs, decide } = gate;
// Objects built inside the vm context have a foreign prototype; copy them before deep equality.
const plain = (o: unknown) => JSON.parse(JSON.stringify(o)) as Record<string, unknown>;

const dirs: string[] = [];
async function tmp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "keel-stop-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const workdir = "/tmp/keel-proj";
const active = {
  [workdir]: { run_id: "run-1", status: "running", current_node: "wait-ci", updated_at: "2026-10-07T00:00:00.000Z" },
};

function event(over: Record<string, unknown> = {}) {
  return { cwd: `${workdir}/.worktrees/x`, stop_hook_active: false, session_id: "s", ...over };
}

describe("evaluate branches", () => {
  it("allows when stop_hook_active is true", () => {
    expect(evaluate(event({ stop_hook_active: true }), active).action).toBe("allow");
    expect(evaluate(event({ stop_hook_active: "true" }), active).action).toBe("allow");
  });
  it("allows when the index is missing or not an object", () => {
    expect(evaluate(event(), null).action).toBe("allow");
    expect(evaluate(event(), undefined).action).toBe("allow");
    expect(evaluate(event(), []).action).toBe("allow");
  });
  it("allows when cwd is not under any indexed workdir", () => {
    expect(evaluate(event({ cwd: "/tmp/other" }), active).action).toBe("allow");
    expect(evaluate(event({ cwd: "/tmp/keel-proj-extra" }), active).action).toBe("allow");
    expect(evaluate(event({ cwd: "" }), active).action).toBe("allow");
  });
  it("allows terminal / paused / stalled statuses", () => {
    for (const status of ["done", "stopped", "stalled", "paused", "waiting_human"]) {
      const index = { [workdir]: { ...active[workdir], status } };
      expect(evaluate(event(), index).action).toBe("allow");
    }
  });
  it("blocks an unfinished run whose cwd equals or sits under the indexed workdir", () => {
    expect(plain(evaluate(event(), active))).toMatchObject({ action: "block", run_id: "run-1", current_node: "wait-ci" });
    expect(evaluate(event({ cwd: workdir }), active).action).toBe("block");
    expect(evaluate(event({ cwd: `${workdir}/` }), active).action).toBe("block");
    expect(evaluate(event({ cwd: `${workdir}/a/../b` }), active).action).toBe("block");
  });
  it("lets KEEL workers inside the run worktree end; still gates the lead in the repo dir (real run ⑭)", () => {
    const wt = `${workdir}/.worktrees/keel-run-1`;
    const index = { [workdir]: { worktree: wt, run_id: "run-1", status: "running", current_node: "implement", updated_at: "t" } };
    expect(plain(evaluate(event({ cwd: wt }), index))).toMatchObject({ action: "allow", why: "worker_worktree" });
    expect(evaluate(event({ cwd: `${wt}/src` }), index).action).toBe("allow");
    expect(plain(evaluate(event({ cwd: workdir }), index))).toMatchObject({ action: "block", run_id: "run-1" });
  });
  it("prefers the longest matching workdir prefix", () => {
    const index = {
      [workdir]: { run_id: "parent", status: "running", current_node: "a", updated_at: "t" },
      [`${workdir}/.worktrees/x`]: { run_id: "child", status: "running", current_node: "b", updated_at: "t" },
    };
    expect(plain(evaluate(event(), index))).toMatchObject({ action: "block", run_id: "child" });
  });
});

describe("harness output", () => {
  const reason = "KEEL：run run-1 未完成（wait-ci）。如果你是 KEEL 派出的 worker（任务说明里有 dispatch_key），交完报告直接结束，不要调用 keel_*；如果你是主控，先调用 keel_status 取下一步，照 next 执行。";
  const blocked = { action: "block" as const, run_id: "run-1", current_node: "wait-ci" };
  it("emits Claude Code {decision, reason} and Codex {decision, reason, continue}", () => {
    expect(plain(formatOutput("claude-code", blocked))).toEqual({ decision: "block", reason });
    expect(plain(formatOutput("codex", blocked))).toEqual({ decision: "block", reason, continue: true });
  });
  it("emits {} when allowing, for both harnesses", () => {
    expect(plain(formatOutput("claude-code", { action: "allow" }))).toEqual({});
    expect(plain(formatOutput("codex", { action: "allow" }))).toEqual({});
  });
  it("parses --harness and --index", () => {
    expect(plain(parseArgs(["--harness", "codex", "--index", "/abs/active.json"]))).toEqual({ harness: "codex", index: "/abs/active.json" });
  });
});

describe("decide fail-open", () => {
  it("allows an unreadable or unparseable index and unparseable stdin", () => {
    const stdin = JSON.stringify(event());
    expect(plain(decide({ harness: "codex" }, stdin, null))).toEqual({});
    expect(plain(decide({ harness: "claude-code" }, stdin, "{not json"))).toEqual({});
    expect(plain(decide({ harness: "codex" }, "not-json", JSON.stringify(active)))).toEqual({});
    expect(plain(decide({ harness: "codex" }, stdin, JSON.stringify(active)))).toMatchObject({ decision: "block", continue: true });
  });
});

function runOsa(args: string[], stdin: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/osascript", ["-l", "JavaScript", script, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => { stdout += c; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout }));
    child.stdin.end(stdin);
  });
}

describe.runIf(process.platform === "darwin")("osascript stdout contract (macOS only)", () => {
  it("prints one JSON object, blocks an active run, and fails open", async () => {
    const dir = await tmp();
    const index = path.join(dir, "active.json");
    await writeFile(index, JSON.stringify(active), "utf8");
    const blocked = await runOsa(["--harness", "claude-code", "--index", index], JSON.stringify(event()));
    expect(blocked.code).toBe(0);
    expect(JSON.parse(blocked.stdout)).toMatchObject({ decision: "block" });
    const garbage = await runOsa(["--harness", "codex", "--index", index], "{{{");
    expect(JSON.parse(garbage.stdout)).toEqual({});
    const noIndex = await runOsa(["--harness", "codex", "--index", path.join(dir, "missing.json")], JSON.stringify(event()));
    expect(JSON.parse(noIndex.stdout)).toEqual({});
  });
});
