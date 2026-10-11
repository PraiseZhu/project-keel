import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hookCommand, withKeelStop, type HookPaths } from "../../src/node/hooks-install.ts";
import { hasKeelStop, KEEL_STOP_MARK, readStopHookStatus, statusFromConfigText } from "../../src/node/hooks-status.ts";
import { STOP_HOOK_LABELS, renderStopHookStatus } from "../../src/panel/hooks-status.ts";
import { dispatch } from "../../src/node/rpc.ts";

const dirs: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const PATHS: HookPaths = {
  pluginDir: "/fixture/cindy-brain/keel",
  dataDir: "/fixture/ghost-fs/keel",
  claudeConfig: "/fixture/.claude/settings.json",
  codexConfig: "/fixture/codex-home/hooks.json",
  agentsDir: "/fixture/.claude/agents",
};
const installedConfig = () => withKeelStop({}, hookCommand("claude-code", PATHS)).next;

async function tmp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "keel-hook-status-"));
  dirs.push(dir);
  return dir;
}

describe("Stop hook install status", () => {
  it("recognizes the installed hook and older manual installs: installed / not_installed / unreadable", () => {
    expect(hasKeelStop({ hooks: { Stop: [] } })).toBe(false);
    const installed = installedConfig();
    expect(JSON.stringify(installed)).toContain(KEEL_STOP_MARK);
    expect(hasKeelStop(installed)).toBe(true);
    expect(hasKeelStop({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node /x/keel-stop-gate.mjs --harness codex" }] }] } })).toBe(true);
    expect(statusFromConfigText(JSON.stringify(installed))).toBe("installed");
    expect(statusFromConfigText(JSON.stringify({ hooks: { Stop: [] } }))).toBe("not_installed");
    expect(statusFromConfigText("not-json")).toBe("unreadable");
  });

  it("reads fixture files, never the real home configs", async () => {
    const dir = await tmp();
    const claude = path.join(dir, "settings.json");
    const missing = path.join(dir, "missing.json");
    const bad = path.join(dir, "bad.json");
    await writeFile(claude, `${JSON.stringify(installedConfig(), null, 2)}\n`);
    await writeFile(bad, "{");
    expect(await readStopHookStatus(claude)).toBe("installed");
    expect(await readStopHookStatus(missing)).toBe("not_installed");
    expect(await readStopHookStatus(bad)).toBe("unreadable");
    expect(claude.startsWith(os.homedir())).toBe(false);
  });

  it("hooks/status RPC accepts fixture paths", async () => {
    const dir = await tmp();
    const claude = path.join(dir, "claude.json");
    const codex = path.join(dir, "codex.json");
    await writeFile(claude, JSON.stringify(installedConfig()));
    await writeFile(codex, JSON.stringify({ hooks: { Stop: [] } }));
    const out = await dispatch("hooks/status", { claude_config: claude, codex_config: codex });
    expect(out.result).toEqual({ claude_code: "installed", codex: "not_installed" });
  });

  it("settings copy is 已安装 / 未安装 / 无法读取", () => {
    expect(STOP_HOOK_LABELS.installed).toBe("已安装");
    expect(STOP_HOOK_LABELS.not_installed).toBe("未安装");
    expect(STOP_HOOK_LABELS.unreadable).toBe("无法读取");
    expect(renderStopHookStatus({ claude_code: "installed", codex: "unreadable" })).toContain("已安装");
    expect(renderStopHookStatus({ claude_code: "installed", codex: "unreadable" })).toContain("无法读取");
  });
});
