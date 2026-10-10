import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  GATE_SCRIPT,
  MARK,
  hasKeelStop,
  installHook,
  isVacuousConfig,
  keelNodeAgentSource,
  mergeKeelStop,
  removeKeelStop,
  statusHook,
  uninstallHook,
} from "../../scripts/hooks/install.mjs";
import { toActiveIndex, writeActiveIndex } from "../../src/main/store/active-index.ts";
import { fakeHost } from "../helpers/fakeHost.ts";

const installer = fileURLToPath(new URL("../../scripts/hooks/install.mjs", import.meta.url));
const dirs: string[] = [];

async function tmp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "keel-hook-install-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const otherStop = { matcher: "conclusion-first", hooks: [{ type: "command", command: "conclusion-first-gate" }] };
const fixture = {
  keep: true,
  hooks: {
    PreToolUse: [{ hooks: [{ type: "command", command: "other" }] }],
    Stop: [otherStop],
  },
};

async function ownersTree(root: string, owners: string[]) {
  for (const o of owners) await mkdir(path.join(root, o, "ghost-fs", "keel"), { recursive: true });
}

describe("merge / strip preserve foreign entries", () => {
  it("inserts a KEEL Stop group and leaves every other field alone", () => {
    const next = mergeKeelStop(fixture, "claude-code", "/data/runs/active.json");
    expect(next.keep).toBe(true);
    expect(next.hooks.PreToolUse).toEqual(fixture.hooks.PreToolUse);
    expect(next.hooks.Stop.some((g: { matcher?: string }) => g.matcher === "conclusion-first")).toBe(true);
    expect(hasKeelStop(next)).toBe(true);
    expect(JSON.stringify(next)).toContain(MARK);
  });
  it("is idempotent", () => {
    const once = mergeKeelStop(fixture, "codex", "/data/runs/active.json");
    const twice = mergeKeelStop(once, "codex", "/data/runs/active.json");
    const cmds = JSON.stringify(twice.hooks.Stop).split(MARK).length - 1;
    expect(cmds).toBe(1);
  });
  it("uninstall removes only KEEL and can restore a file that did not exist", () => {
    const next = removeKeelStop(mergeKeelStop(fixture, "codex", "/i"));
    expect(next.keep).toBe(true);
    expect(next.hooks.PreToolUse).toEqual(fixture.hooks.PreToolUse);
    expect(hasKeelStop(next)).toBe(false);
    expect(next.hooks.Stop).toEqual([otherStop]);
    expect(isVacuousConfig(removeKeelStop(mergeKeelStop({}, "codex", "/i")))).toBe(true);
  });
});

describe("install / uninstall against tmp fixtures", () => {
  it("backs up, merges, and uninstalls back to the original others", async () => {
    const dir = await tmp();
    const config = path.join(dir, "settings.json");
    const dataDir = path.join(dir, "data");
    await mkdir(dataDir, { recursive: true });
    await writeFile(config, `${JSON.stringify(fixture, null, 2)}\n`);
    const agentsDir = path.join(dir, "agents");
    const installed = await installHook({ target: "claude-code", config, dataDir, agentsDir });
    expect(installed.existed).toBe(true);
    expect(existsSync(installed.backup!)).toBe(true);
    const after = JSON.parse(await readFile(config, "utf8"));
    expect(hasKeelStop(after)).toBe(true);
    expect(after.hooks.PreToolUse).toEqual(fixture.hooks.PreToolUse);
    await installHook({ target: "claude-code", config, dataDir, agentsDir });
    const again = JSON.parse(await readFile(config, "utf8"));
    expect(JSON.stringify(again.hooks.Stop).split(MARK).length - 1).toBe(1);
    const undone = await uninstallHook({ target: "claude-code", config });
    expect(undone.deleted).toBe(false);
    const restored = JSON.parse(await readFile(config, "utf8"));
    expect(hasKeelStop(restored)).toBe(false);
    expect(restored.hooks.Stop).toEqual([otherStop]);
    expect(restored.keep).toBe(true);
  });
  it("records a missing origin and deletes the file on uninstall when it is empty", async () => {
    const dir = await tmp();
    const config = path.join(dir, "hooks.json");
    const dataDir = path.join(dir, "data");
    await mkdir(dataDir, { recursive: true });
    expect(existsSync(config)).toBe(false);
    await installHook({ target: "codex", config, dataDir });
    expect(existsSync(config)).toBe(true);
    const backups = (await readdir(dir)).filter((n) => n.includes(".keel-backup-"));
    expect(backups.length).toBeGreaterThan(0);
    const marker = JSON.parse(await readFile(path.join(dir, backups[0]!), "utf8"));
    expect(marker.__keel_origin_missing).toBe(true);
    const undone = await uninstallHook({ target: "codex", config });
    expect(undone.deleted).toBe(true);
    expect(existsSync(config)).toBe(false);
  });
  it("dry-run prints the would-be file and writes nothing", async () => {
    const dir = await tmp();
    const config = path.join(dir, "hooks.json");
    const dataDir = path.join(dir, "data");
    await mkdir(dataDir, { recursive: true });
    const r = await installHook({ target: "codex", config, dataDir, dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.content).toContain(MARK);
    expect(existsSync(config)).toBe(false);
    expect((await readdir(dir)).some((n) => n.includes(".keel-backup-"))).toBe(false);
  });
  it("status reports installed vs not, and Codex adds the trust hint", async () => {
    const dir = await tmp();
    const config = path.join(dir, "hooks.json");
    const dataDir = path.join(dir, "data");
    await mkdir(dataDir, { recursive: true });
    const before = await statusHook({ target: "codex", config });
    expect(before.installed).toBe(false);
    expect(before.note).toContain("信任");
    await installHook({ target: "codex", config, dataDir });
    expect((await statusHook({ target: "codex", config })).installed).toBe(true);
    expect((await statusHook({ target: "claude-code", config })).note).toBeUndefined();
  });
  it("install --target claude-code copies agents/keel-node.md without a hardcoded model", async () => {
    const dir = await tmp();
    const config = path.join(dir, "settings.json");
    const dataDir = path.join(dir, "data");
    const agentsDir = path.join(dir, "agents");
    await mkdir(dataDir, { recursive: true });
    await writeFile(config, `${JSON.stringify(fixture, null, 2)}\n`);
    const installed = await installHook({ target: "claude-code", config, dataDir, agentsDir });
    const dest = path.join(agentsDir, "keel-node.md");
    expect(installed.agent).toBe(dest);
    expect(existsSync(dest)).toBe(true);
    const text = await readFile(dest, "utf8");
    expect(text).toMatch(/^---\nname: keel-node\n/);
    expect(text).toMatch(/tools: \[Read, Write, Edit, Bash, Grep, Glob\]/);
    expect(text).not.toMatch(/^model:/m);
    expect(keelNodeAgentSource()).toMatch(/scripts\/hooks\/keel-node\.md$/);
    const dry = await installHook({ target: "codex", config, dataDir, agentsDir, dryRun: true });
    expect(dry.agent).toBeUndefined();
  });
});

describe("data-dir auto-discovery", () => {
  it("uses the only owners/*/ghost-fs/keel directory", async () => {
    const dir = await tmp();
    const owners = path.join(dir, "owners");
    await ownersTree(owners, ["abc"]);
    const config = path.join(dir, "hooks.json");
    const r = await installHook({ target: "codex", config, ownersRoot: owners });
    expect(r.next.hooks.Stop[0].hooks[0].command).toContain(path.join(owners, "abc", "ghost-fs", "keel", "runs", "active.json"));
  });
  it("errors when zero or several data dirs exist", async () => {
    const dir = await tmp();
    const none = path.join(dir, "owners-none");
    await mkdir(none, { recursive: true });
    const many = path.join(dir, "owners-many");
    await ownersTree(many, ["a", "b"]);
    const config = path.join(dir, "hooks.json");
    await expect(installHook({ target: "codex", config, ownersRoot: none })).rejects.toThrow(/找不到 KEEL 数据目录/);
    await expect(installHook({ target: "codex", config, ownersRoot: many })).rejects.toThrow(/找到 2 个/);
    expect(existsSync(config)).toBe(false);
  });
});

describe("CLI dry-run does not write", () => {
  it("install --dry-run leaves the fixture directory empty of configs", async () => {
    const dir = await tmp();
    const config = path.join(dir, "hooks.json");
    const dataDir = path.join(dir, "data");
    await mkdir(dataDir, { recursive: true });
    const out = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [installer, "install", "--target", "codex", "--config", config, "--data-dir", dataDir, "--dry-run"], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (c) => { stdout += c; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout }));
    });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain(MARK);
    expect(out.stdout).toContain(GATE_SCRIPT);
    expect(existsSync(config)).toBe(false);
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

describe("keelCommand shell quoting (review F16-01 / CodeQL)", () => {
  it("passes paths with shell metacharacters to the hook as exact argv", async () => {
    const { execFileSync } = await import("node:child_process");
    const { keelCommand } = await import("../../scripts/hooks/install.mjs");
    const nasty = [
      "/tmp/data/$(printf SUBSTITUTED)/runs/active.json",
      "/tmp/data/`printf TICKED`/active.json",
      "/tmp/it's here/\\back\\slash/\"dq\"/active.json",
      "/opt/Application Support/Cindy/owners/x/ghost-fs/keel/runs/active.json",
    ];
    for (const path of nasty) {
      // printf '%s\n' prints each argv element on its own line; the last one is the --index value.
      const cmd = keelCommand("codex", path, "/usr/bin/printf", "%s\\n");
      const out = execFileSync("/bin/sh", ["-c", cmd], { encoding: "utf8" }).split("\n").filter(Boolean);
      expect(out.at(-1)).toBe(path);
    }
  });
});
