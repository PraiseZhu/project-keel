import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { evaluate, formatOutput, parseArgs, runStopGate } from "../../scripts/hooks/keel-stop-gate.mjs";

const script = fileURLToPath(new URL("../../scripts/hooks/keel-stop-gate.mjs", import.meta.url));
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
    const hit = evaluate(event(), active);
    expect(hit).toMatchObject({ action: "block", run_id: "run-1", current_node: "wait-ci" });
    expect(evaluate(event({ cwd: workdir }), active).action).toBe("block");
  });
  it("lets KEEL workers inside the run worktree end; still gates the lead in the repo dir (real run ⑭)", () => {
    const wt = `${workdir}/.worktrees/keel-run-1`;
    const index = { [workdir]: { worktree: wt, run_id: "run-1", status: "running", current_node: "implement", updated_at: "t" } };
    expect(evaluate(event({ cwd: wt }), index)).toMatchObject({ action: "allow", why: "worker_worktree" });
    expect(evaluate(event({ cwd: `${wt}/src` }), index).action).toBe("allow");
    expect(evaluate(event({ cwd: workdir }), index)).toMatchObject({ action: "block", run_id: "run-1" });
  });
  it("prefers the longest matching workdir prefix", () => {
    const index = {
      [workdir]: { run_id: "parent", status: "running", current_node: "a", updated_at: "t" },
      [`${workdir}/.worktrees/x`]: { run_id: "child", status: "running", current_node: "b", updated_at: "t" },
    };
    expect(evaluate(event(), index)).toMatchObject({ action: "block", run_id: "child" });
  });
});

describe("harness output", () => {
  const reason = "KEEL：run run-1 未完成（wait-ci）。如果你是 KEEL 派出的 worker（任务说明里有 dispatch_key），交完报告直接结束，不要调用 keel_*；如果你是主控，先调用 keel_status 取下一步，照 next 执行。";
  const blocked = { action: "block" as const, run_id: "run-1", current_node: "wait-ci" };
  it("emits Claude Code {decision, reason} and Codex {decision, reason, continue}", () => {
    expect(formatOutput("claude-code", blocked)).toEqual({ decision: "block", reason });
    expect(formatOutput("codex", blocked)).toEqual({ decision: "block", reason, continue: true });
  });
  it("emits {} when allowing, for both harnesses", () => {
    expect(formatOutput("claude-code", { action: "allow" })).toEqual({});
    expect(formatOutput("codex", { action: "allow" })).toEqual({});
  });
});

describe("runStopGate fail-open", () => {
  it("allows unreadable or unparseable index files", async () => {
    const dir = await tmp();
    const missing = path.join(dir, "nope.json");
    const bad = path.join(dir, "bad.json");
    await writeFile(bad, "{not json", "utf8");
    const stdin = JSON.stringify(event());
    expect(await runStopGate({ harness: "codex", index: missing, timeoutMs: 5000 }, stdin)).toEqual({});
    expect(await runStopGate({ harness: "claude-code", index: bad, timeoutMs: 5000 }, stdin)).toEqual({});
  });
  it("allows unparseable stdin", async () => {
    const dir = await tmp();
    const index = path.join(dir, "active.json");
    await writeFile(index, JSON.stringify(active), "utf8");
    expect(await runStopGate({ harness: "codex", index, timeoutMs: 5000 }, "not-json")).toEqual({});
  });
});

function runCli(args: string[], stdin: string, extra?: { endStdin?: boolean }): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (stdin) child.stdin.write(stdin);
    if (extra?.endStdin === false) return;
    child.stdin.end();
  });
}

describe("CLI stdout contract", () => {
  it("prints one JSON object and never leaks exceptions to stdout", async () => {
    const dir = await tmp();
    const index = path.join(dir, "active.json");
    await writeFile(index, JSON.stringify(active), "utf8");
    const blocked = await runCli(["--harness", "claude-code", "--index", index], JSON.stringify(event()));
    expect(blocked.code).toBe(0);
    expect(JSON.parse(blocked.stdout)).toMatchObject({ decision: "block" });
    expect(blocked.stdout.trim().startsWith("{")).toBe(true);
    const garbage = await runCli(["--harness", "codex", "--index", index], "{{{");
    expect(garbage.code).toBe(0);
    expect(JSON.parse(garbage.stdout)).toEqual({});
    const noIndex = await runCli(["--harness", "codex", "--index", path.join(dir, "missing.json")], JSON.stringify(event()));
    expect(JSON.parse(noIndex.stdout)).toEqual({});
  });
  it("times out fail-open without waiting for stdin to end", async () => {
    const dir = await tmp();
    const index = path.join(dir, "active.json");
    await writeFile(index, JSON.stringify(active), "utf8");
    const r = await runCli(["--harness", "codex", "--index", index, "--timeout-ms", "80"], "", { endStdin: false });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.trim().split("\n")[0]!)).toEqual({});
  });
  it("parses --harness and --index", () => {
    expect(parseArgs(["--harness", "codex", "--index", "/abs/active.json"])).toMatchObject({ harness: "codex", index: "/abs/active.json" });
  });
});
