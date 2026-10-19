import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_FILE,
  CLEANUP_JXA,
  GATE_FILE,
  defaultHookPaths,
  ensureHook,
  ensureHooks,
  hookCommand,
  quote,
  withKeelStop,
  type HookPaths,
} from "../../src/node/hooks-install.ts";
import { hasKeelStop, KEEL_STOP_MARK } from "../../src/node/hooks-status.ts";
import { toActiveIndex, writeActiveIndex } from "../../src/main/store/active-index.ts";
import { fakeHost } from "../helpers/fakeHost.ts";

const repoPlugin = fileURLToPath(new URL("../../plugin/", import.meta.url));
const dirs: string[] = [];

async function tmp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "keel-hook-install-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A Cindy-shaped tree in a temp dir: owners/o/cindy-brain/keel with the shipped hook files, plus both harness homes. */
async function world(opts: { claude?: boolean; codex?: boolean } = {}): Promise<HookPaths> {
  const home = await tmp();
  const pluginDir = path.join(home, "owners/o/cindy-brain/keel");
  await mkdir(path.join(pluginDir, "hooks"), { recursive: true });
  await mkdir(path.join(pluginDir, "node"), { recursive: true });
  await copyFile(path.join(repoPlugin, GATE_FILE), path.join(pluginDir, GATE_FILE));
  await copyFile(path.join(repoPlugin, AGENT_FILE), path.join(pluginDir, AGENT_FILE));
  const paths = defaultHookPaths(path.join(pluginDir, "node"), home)!;
  if (opts.claude !== false) await mkdir(path.dirname(paths.claudeConfig), { recursive: true });
  if (opts.codex !== false) await mkdir(path.dirname(paths.codexConfig), { recursive: true });
  return paths;
}

const otherStop = { matcher: "conclusion-first", hooks: [{ type: "command", command: "conclusion-first-gate" }] };
const fixture = {
  keep: true,
  hooks: {
    PreToolUse: [{ hooks: [{ type: "command", command: "other" }] }],
    Stop: [otherStop],
  },
};
const PATHS: HookPaths = {
  pluginDir: "/p/cindy-brain/keel",
  dataDir: "/p/ghost-fs/keel",
  claudeConfig: "/h/.claude/settings.json",
  codexConfig: "/h/codex-home/hooks.json",
  agentsDir: "/h/.claude/agents",
};
const keelCount = (cfg: unknown) => JSON.stringify((cfg as { hooks: { Stop: unknown[] } }).hooks.Stop).split(GATE_FILE.split("/")[1]!).length - 1;

describe("withKeelStop keeps foreign entries and leaves exactly one KEEL hook", () => {
  it("inserts one group and leaves every other field and Stop group alone", () => {
    const { next, changed } = withKeelStop(fixture, hookCommand("claude-code", PATHS));
    expect(changed).toBe(true);
    expect(next.keep).toBe(true);
    expect((next.hooks as typeof fixture.hooks).PreToolUse).toEqual(fixture.hooks.PreToolUse);
    expect((next.hooks as typeof fixture.hooks).Stop[0]).toEqual(otherStop);
    expect(hasKeelStop(next)).toBe(true);
    expect(keelCount(next)).toBe(1);
  });
  it("is idempotent", () => {
    const cmd = hookCommand("codex", PATHS);
    const once = withKeelStop(fixture, cmd).next;
    const twice = withKeelStop(once, cmd);
    expect(twice.changed).toBe(false);
    expect(twice.next).toBe(once);
  });
  it("replaces older manual installs, including one shared with a foreign hook", () => {
    const old = { type: "command", command: "'/usr/local/bin/node' '/repo/scripts/hooks/keel-stop-gate.mjs' --harness codex --index '/i'", timeout: 5 };
    const cfg = { hooks: { Stop: [{ hooks: [old] }, { hooks: [{ type: "command", command: "x" }, old] }] } };
    const { next, changed } = withKeelStop(cfg, hookCommand("codex", PATHS));
    expect(changed).toBe(true);
    const stop = (next.hooks as { Stop: { hooks: { command: string }[] }[] }).Stop;
    expect(stop).toHaveLength(2);
    expect(stop[0]!.hooks).toEqual([{ type: "command", command: "x" }]);
    expect(JSON.stringify(next)).not.toContain("keel-stop-gate.mjs");
  });
});

describe("cleanup script strips only KEEL entries", () => {
  const strip = (() => {
    const ctx: Record<string, unknown> = {};
    runInNewContext(CLEANUP_JXA, ctx);
    return ctx.stripKeel as (j: unknown) => unknown;
  })();
  it("removes KEEL hooks and empty containers, keeps the rest", () => {
    const installed = withKeelStop(fixture, hookCommand("claude-code", PATHS)).next;
    expect(JSON.parse(JSON.stringify(strip(structuredClone(installed))))).toEqual(fixture);
    const onlyKeel = withKeelStop({}, hookCommand("codex", PATHS)).next;
    expect(JSON.parse(JSON.stringify(strip(structuredClone(onlyKeel))))).toEqual({});
  });
  it("has no single quote, so it survives shell quoting unchanged", () => {
    expect(CLEANUP_JXA).not.toContain("'");
    expect(CLEANUP_JXA).toContain(KEEL_STOP_MARK);
  });
});

describe("ensureHook against a temp Cindy tree", () => {
  it("installs both harnesses, backs up an existing config once, and copies the agent for Claude Code only", async () => {
    const paths = await world();
    await writeFile(paths.claudeConfig, `${JSON.stringify(fixture, null, 2)}\n`);
    const out = await ensureHooks(paths, "darwin");
    expect(out.claude_code.outcome).toBe("installed");
    expect(out.codex.outcome).toBe("installed");
    const claude = JSON.parse(await readFile(paths.claudeConfig, "utf8"));
    expect(claude.keep).toBe(true);
    expect(keelCount(claude)).toBe(1);
    expect(JSON.parse(await readFile(`${paths.claudeConfig}.keel-backup`, "utf8"))).toEqual(fixture);
    expect(existsSync(`${paths.codexConfig}.keel-backup`)).toBe(false);
    const agent = await readFile(path.join(paths.agentsDir, "keel-node.md"), "utf8");
    expect(agent).toMatch(/^---\nname: keel-node\n/);
    expect(agent).not.toMatch(/^model:/m);
    expect(JSON.stringify(JSON.parse(await readFile(paths.codexConfig, "utf8")))).toContain("--harness codex");
    expect(JSON.stringify(claude)).toContain(path.join(paths.dataDir, "runs/active.json"));

    const again = await ensureHooks(paths, "darwin");
    expect(again.claude_code.outcome).toBe("unchanged");
    expect(again.codex.outcome).toBe("unchanged");
  });

  it("keeps a symlinked 0600 settings file a symlink and private; the backup is private too", async () => {
    const paths = await world({ codex: false });
    const real = path.join(path.dirname(paths.claudeConfig), "dotfiles-settings.json");
    await writeFile(real, JSON.stringify(fixture), { mode: 0o600 });
    await symlink(real, paths.claudeConfig);
    expect((await ensureHook("claude-code", paths)).outcome).toBe("installed");
    expect((await lstat(paths.claudeConfig)).isSymbolicLink()).toBe(true);
    expect((await stat(real)).mode & 0o777).toBe(0o600);
    expect(hasKeelStop(JSON.parse(await readFile(real, "utf8")))).toBe(true);
    expect((await stat(`${paths.claudeConfig}.keel-backup`)).mode & 0o777).toBe(0o600);
  });

  it("reports updated when it replaces an older KEEL entry", async () => {
    const paths = await world({ codex: false });
    await writeFile(paths.claudeConfig, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node /x/keel-stop-gate.mjs" }] }] } }));
    expect((await ensureHook("claude-code", paths)).outcome).toBe("updated");
  });

  it("skips a harness whose config directory does not exist and never writes there", async () => {
    const paths = await world({ codex: false });
    const out = await ensureHook("codex", paths);
    expect(out.outcome).toBe("skipped");
    expect(existsSync(path.dirname(paths.codexConfig))).toBe(false);
  });

  it("leaves an unparseable config untouched", async () => {
    const paths = await world();
    await writeFile(paths.claudeConfig, "{ not json");
    expect((await ensureHook("claude-code", paths)).outcome).toBe("unreadable");
    expect(await readFile(paths.claudeConfig, "utf8")).toBe("{ not json");
  });

  it("does nothing off macOS or outside the Cindy plugin layout", async () => {
    const paths = await world();
    expect((await ensureHooks(paths, "linux")).claude_code.outcome).toBe("skipped");
    expect((await ensureHooks(null, "darwin")).codex.outcome).toBe("skipped");
    expect(existsSync(paths.claudeConfig)).toBe(false);
    expect(defaultHookPaths("/somewhere/else/node")).toBeNull();
  });

  it("derives the data dir from the installed plugin dir", () => {
    const p = defaultHookPaths("/U/owners/abc/cindy-brain/keel/node", "/U")!;
    expect(p.pluginDir).toBe("/U/owners/abc/cindy-brain/keel");
    expect(p.dataDir).toBe("/U/owners/abc/ghost-fs/keel");
    expect(p.claudeConfig).toBe("/U/.claude/settings.json");
    expect(p.codexConfig).toBe("/U/Library/Application Support/Cindy/codex-home/hooks.json");
  });

  it("follows Cindy's namespace layout: cindy-brain/_ns/<ns>/<id> keeps data in ghost-fs/_ns__<ns>__<id>", () => {
    const p = defaultHookPaths("/U/owners/abc/cindy-brain/_ns/xd/keel/node", "/U")!;
    expect(p.pluginDir).toBe("/U/owners/abc/cindy-brain/_ns/xd/keel");
    expect(p.dataDir).toBe("/U/owners/abc/ghost-fs/_ns__xd__keel");
    expect(p.agentsDir).toBe("/U/.claude/agents");
    expect(defaultHookPaths("/U/owners/abc/other/_ns/xd/keel/node", "/U")).toBeNull();
  });
});

describe("hook command quoting (review F16-01 / CodeQL)", () => {
  it("passes paths with shell metacharacters through as exact argv", () => {
    const nasty = [
      "/tmp/data/$(printf SUBSTITUTED)/runs/active.json",
      "/tmp/data/`printf TICKED`/active.json",
      "/tmp/it's here/\\back\\slash/\"dq\"/active.json",
      "/opt/Application Support/Cindy/owners/x/ghost-fs/keel/runs/active.json",
    ];
    for (const p of nasty) {
      const out = execFileSync("/bin/sh", ["-c", `printf '%s\\n' ${quote(p)}`], { encoding: "utf8" });
      expect(out).toBe(`${p}\n`);
    }
  });
});

describe.runIf(process.platform === "darwin")("installed command end to end (macOS only)", () => {
  const sh = (cmd: string, stdin: string) => execFileSync("/bin/sh", ["-c", cmd], { input: stdin, encoding: "utf8" });

  it("runs the gate while the plugin is installed and removes itself once the plugin is gone", async () => {
    const paths = await world();
    await writeFile(paths.claudeConfig, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o600 });
    await ensureHooks(paths, "darwin");
    await mkdir(path.join(paths.dataDir, "runs"), { recursive: true });
    await writeFile(path.join(paths.dataDir, "runs/active.json"), JSON.stringify({ "/w": { run_id: "r1", status: "running", current_node: "n" } }));
    const cmd = (JSON.parse(await readFile(paths.claudeConfig, "utf8")).hooks.Stop as { hooks: { command: string }[] }[]).at(-1)!.hooks[0]!.command;
    expect(JSON.parse(sh(cmd, JSON.stringify({ cwd: "/w", stop_hook_active: false })))).toMatchObject({ decision: "block" });

    await rm(path.join(paths.pluginDir), { recursive: true, force: true });
    expect(JSON.parse(sh(cmd, JSON.stringify({ cwd: "/w", stop_hook_active: false })))).toEqual({});
    expect(JSON.parse(await readFile(paths.claudeConfig, "utf8"))).toEqual(fixture);
    expect((await stat(paths.claudeConfig)).mode & 0o777).toBe(0o600);
    expect(existsSync(path.join(paths.agentsDir, "keel-node.md"))).toBe(false);
  });
});

describe("active index helper", () => {
  it("toActiveIndex keeps the newer row per workdir", () => {
    const idx = toActiveIndex([
      { workdir: "/r/a", run_id: "old", status: "running", current_node: "x", updated_at: "2026-10-07T00:00:00.000Z" },
      { workdir: "/r/a", run_id: "new", status: "waiting_human", current_node: "y", updated_at: "2026-10-07T01:00:00.000Z" },
      { workdir: "/r/b", run_id: "b", status: "running", current_node: "z", updated_at: "2026-10-07T00:00:00.000Z" },
    ]);
    expect(idx["/r/a"]?.run_id).toBe("new");
    expect(idx["/r/b"]?.run_id).toBe("b");
  });
  it("writeActiveIndex serializes the whole write", async () => {
    const h = fakeHost();
    const inner = h.fs.bind(h);
    h.fs = async (req) => {
      await new Promise((r) => setTimeout(r, 5));
      return inner(req);
    };
    await Promise.all([
      writeActiveIndex(h, { "/r": { run_id: "a", status: "running", current_node: "n", updated_at: "t1" } }),
      writeActiveIndex(h, { "/r": { run_id: "b", status: "running", current_node: "n", updated_at: "t2" } }),
    ]);
    const stored = JSON.parse(h.files.get("runs/active.json")!);
    expect(["a", "b"]).toContain(stored["/r"].run_id);
  });
});
