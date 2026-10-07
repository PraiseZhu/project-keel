import { afterEach, describe, expect, it } from "vitest";
import { makeWorld, makeE2eHost, startRun, leadLoop, cleanupRepos, SC } from "../e2e/helpers.ts";
import { LANE_PRESETS } from "../../src/shared/types.ts";
import { resolveLane } from "../../src/shared/lanes.ts";
import { runTool } from "../../src/main/dispatch.ts";
import { makeContext } from "../../src/main/context.ts";
import { fakeHost } from "../helpers/fakeHost.ts";

afterEach(cleanupRepos);

const KV_LANES = [{ repo: "acme/app", preset: "gated-handoff" as const, verifyCheck: "agent-verify" }];

describe("AUDIT-V2-01 runtime lanes", () => {
  it("uses kv.lanes for PR snapshot and verifyCheck sink, not the packed empty profile", async () => {
    const world = makeWorld();
    const host = makeE2eHost(world);
    host.kv.lanes = KV_LANES;
    const originalNode = host.node.bind(host);
    host.node = async (method, params: Record<string, unknown>, options) => {
      const out = await originalNode(method, params, options);
      if (method === "pr/snapshot" && out.ok) {
        const lane = resolveLane(params.profile as { lanes: typeof KV_LANES }, "acme/app");
        out.result = {
          ...out.result,
          preset: lane.rule.preset,
          rule: lane.rule,
          verification: lane.match?.verifyCheck ? { check: lane.match.verifyCheck, state: "missing" } : null,
        };
      }
      return out;
    };
    const started = await startRun(host, { goal: "修登录报错", repo_dir: world.repoDir, lead: "codex", playbook: "bug-fix", scope: ["src/**"], sc: [...SC] });
    const run = await leadLoop(host, started, world, {
      stopWhen: (next) => next.kind === "done" || next.kind === "stop" || (next.kind === "decide" && next.gate_id === "done"),
    });
    const sink = host.nodeCalls.filter((c) => c.method === "gh/commit-status");
    const profiles = host.nodeCalls.filter((c) => c.method === "pr/snapshot").map((c) => (c.params as { profile?: { lanes?: unknown } }).profile);
    expect(profiles.at(-1)?.lanes).toEqual(KV_LANES);
    expect(sink.some((c) => (c.params as { context?: string }).context === "agent-verify")).toBe(true);
    expect(run.next.kind).not.toBe("done");
  });

  it("falls back to packed built lanes when kv has no lanes field", async () => {
    const world = makeWorld();
    const host = makeE2eHost(world);
    const originalNode = host.node.bind(host);
    host.node = async (method, params: Record<string, unknown>, options) => {
      const out = await originalNode(method, params, options);
      if (method === "pr/snapshot" && out.ok) {
        const lane = resolveLane(params.profile as { lanes: [] }, "acme/app");
        out.result = { ...out.result, preset: lane.rule.preset, rule: lane.rule };
      }
      return out;
    };
    const started = await startRun(host, { goal: "修登录报错", repo_dir: world.repoDir, lead: "codex", playbook: "bug-fix", scope: ["src/**"], sc: [...SC] });
    const run = await leadLoop(host, started, world);
    const sink = host.nodeCalls.filter((c) => c.method === "gh/commit-status");
    const last = host.nodeCalls.filter((c) => c.method === "pr/snapshot").map((c) => (c.params as { profile?: { lanes?: unknown } }).profile).at(-1);
    expect(last?.lanes).toEqual([]);
    expect(run.next.kind).toBe("done");
    expect(sink).toEqual([]);
    expect(LANE_PRESETS.personal.preset).toBe("personal");
  });

  it("rejects malformed kv.lanes instead of silently using personal", async () => {
    const h = fakeHost({ kv: { lanes: { repo: "acme/app", preset: "gated-handoff" } } });
    const r = await runTool(makeContext(h, "bad-lanes"), "keel_status", {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errorCode).toBe("LANE_CONFIG_INVALID");
  });
});
