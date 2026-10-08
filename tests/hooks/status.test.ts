import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasKeelStop as installHasKeelStop, MARK, mergeKeelStop } from "../../scripts/hooks/install.mjs";
import { hasKeelStop, KEEL_STOP_MARK, readStopHookStatus, statusFromConfigText } from "../../src/node/hooks-status.ts";
import { STOP_HOOK_LABELS, renderStopHookStatus } from "../../src/panel/hooks-status.ts";
import { dispatch } from "../../src/node/rpc.ts";

const dirs: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "keel-hook-status-"));
  dirs.push(dir);
  return dir;
}

describe("Stop hook install status", () => {
  it("reuses hasKeelStop: installed / not_installed / unreadable", () => {
    expect(KEEL_STOP_MARK).toBe(MARK);
    expect(hasKeelStop({ hooks: { Stop: [] } })).toBe(false);
    expect(installHasKeelStop({ hooks: { Stop: [] } })).toBe(false);
    const installed = mergeKeelStop({}, "claude-code", "/data/runs/active.json");
    expect(JSON.stringify(installed)).toContain(MARK);
    expect(hasKeelStop(installed)).toBe(installHasKeelStop(installed));
    expect(statusFromConfigText(JSON.stringify(installed))).toBe("installed");
    expect(statusFromConfigText(JSON.stringify({ hooks: { Stop: [] } }))).toBe("not_installed");
    expect(statusFromConfigText("not-json")).toBe("unreadable");
  });

  it("reads fixture files, never the real home configs", async () => {
    const dir = await tmp();
    const claude = path.join(dir, "settings.json");
    const missing = path.join(dir, "missing.json");
    const bad = path.join(dir, "bad.json");
    await writeFile(claude, `${JSON.stringify(mergeKeelStop({}, "claude-code", "/i"), null, 2)}\n`);
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
    await writeFile(claude, JSON.stringify(mergeKeelStop({}, "claude-code", "/i")));
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
