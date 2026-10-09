import { afterEach, describe, expect, it } from "vitest";
import { makeWorld, makeE2eHost, startRun, leadLoop, cleanupRepos, SC } from "../e2e/helpers.ts";

afterEach(cleanupRepos);

describe("Step 2 run artifacts", () => {
  it("persists node reports and verdict under runs/<id>/artifacts via the serial store", async () => {
    const world = makeWorld();
    const host = makeE2eHost(world);
    const started = await startRun(host, { goal: "修登录报错", repo_dir: world.repoDir, lead: "codex", playbook: "bug-fix", scope: ["src/**"], sc: [...SC] });
    const run = await leadLoop(host, started, world);
    expect(run.next.kind).toBe("done");
    const prefix = `runs/${started.run_id}/artifacts/`;
    const keys = [...host.files.keys()].filter((k) => k.startsWith(prefix));
    expect(keys.some((k) => k.endsWith("/verdict.json"))).toBe(true);
    expect(keys.some((k) => k.includes("/nodes/"))).toBe(true);
    const verdict = JSON.parse(host.files.get(`${prefix}verdict.json`)!);
    expect(verdict.head || verdict.head_sha || verdict.level).toBeTruthy();
  });
});
