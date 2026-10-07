import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, loadRuntimeConfig } from "../src/main/config.ts";
import { DEFAULT_MANUAL } from "../src/shared/manual/schema.ts";
import { DEFAULT_THRESHOLDS, type KeelProfile } from "../src/shared/types.ts";
import { fakeHost } from "./helpers/fakeHost.ts";

const built: KeelProfile = {
  lanes: [{ repo: "acme/app", preset: "personal" }],
  routingPath: "/does-not-read/routing.json",
  boardRepos: ["acme/app"],
  plansDir: "/plans",
};

describe("loadRuntimeConfig", () => {
  it("empty kv uses Appendix C defaults and the packed profile's non-model lanes", async () => {
    const h = fakeHost();
    const cfg = await loadRuntimeConfig(h, built);
    expect(cfg.manual).toEqual(DEFAULT_MANUAL);
    expect(cfg.lanes).toEqual(built.lanes);
    expect(cfg.limits).toEqual(DEFAULT_LIMITS);
    expect(cfg.thresholds).toEqual(DEFAULT_THRESHOLDS);
    expect(h.kvReads).toBe(1);
    expect(h.fetches).toEqual([]);
    expect(h.nodeCalls).toEqual([]);
    expect(h.files.size).toBe(0);
  });

  it("reads manual, lanes, limits, and thresholds from kv without writing", async () => {
    const manual = { ...DEFAULT_MANUAL };
    const h = fakeHost({
      kv: {
        manual,
        lanes: [{ repo: "acme/other", preset: "gated-handoff" }],
        limits: { concurrentRuns: 2, inFlightNodesPerRun: 1, astraBudget: 8 },
        thresholds: { act: 0.6, strict: 0.9 },
      },
    });
    const cfg = await loadRuntimeConfig(h, built);
    expect(cfg.manual.profiles.map((p) => p.id)).toEqual(["sol", "grok"]);
    expect(cfg.lanes).toEqual([{ repo: "acme/other", preset: "gated-handoff" }]);
    expect(cfg.limits).toEqual({ concurrentRuns: 2, inFlightNodesPerRun: 1, astraBudget: 8 });
    expect(cfg.thresholds).toEqual({ act: 0.6, strict: 0.9 });
    expect(h.files.size).toBe(0);
    expect(h.nodeCalls).toEqual([]);
  });

  it("does not treat routingPath as a kv field; packed routing.json stays with roles", async () => {
    const h = fakeHost({ kv: { routingPath: "/injected.json" } });
    const cfg = await loadRuntimeConfig(h, built);
    expect(cfg).not.toHaveProperty("routingPath");
    expect(h.nodeCalls).toEqual([]);
  });
});
