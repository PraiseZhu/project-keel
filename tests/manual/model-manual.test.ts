import { describe, expect, it } from "vitest";
import { KeelError } from "../../src/main/host.ts";
import { resolve, resolveProfileForHarness } from "../../src/main/manual/resolve.ts";
import { family } from "../../src/shared/fanout.ts";
import { resolveDirection } from "../../src/shared/manual/resolve.ts";
import {
  cloneManual,
  DEFAULT_MANUAL,
  exportManual,
  importManual,
  KV_MAX_BYTES,
  parseManual,
  type AgentModel,
  type ModelManual,
  type Profile,
  type Role,
  type Route,
  type TaskType,
} from "../../src/shared/manual/schema.ts";
import { validateManual } from "../../src/shared/manual/validate.ts";

const gptEfforts = ["low", "medium", "high", "xhigh", "max"] as const;
const grokEfforts = ["low", "medium", "high"] as const;

function model(partial: AgentModel): AgentModel {
  return { name: partial.id, visible: true, ...partial };
}

/** Stub /agent-models covering every Appendix C id × agent × provider. */
export function appendixCAgentModels(): AgentModel[] {
  return [
    model({ id: "gpt-6.1-sol", agent: "codex", providerId: "art-cindy", providerName: "Art Cindy", efforts: gptEfforts }),
    model({ id: "gpt-6-luna", agent: "codex", providerId: "art-cindy", providerName: "Art Cindy", efforts: gptEfforts }),
    model({ id: "openai/gpt-6-luna", agent: "codex", providerId: "xd", providerName: "XD", efforts: gptEfforts }),
    model({ id: "gpt-6-astra", agent: "codex", providerId: "art-cindy", providerName: "Art Cindy", efforts: gptEfforts }),
    model({ id: "openai/gpt-6-astra", agent: "codex", providerId: "xd", providerName: "XD", efforts: gptEfforts }),
    model({ id: "grok-4.6", agent: "pi", providerId: "art-cindy", providerName: "Art Cindy", efforts: grokEfforts }),
    model({ id: "grok-4.6", agent: "claude-code", providerId: "art-cindy", providerName: "Art Cindy", efforts: grokEfforts }),
    model({ id: "x-ai-grok/grok-4.6", agent: "pi", providerId: "xd", providerName: "XD", efforts: grokEfforts }),
    model({ id: "anthropic/claude-opus-5-5", agent: "claude-code", providerId: "xd", providerName: "Cindy AI", efforts: gptEfforts }),
    model({ id: "anthropic/claude-haiku-5-5", agent: "claude-code", providerId: "xd", providerName: "Cindy AI", efforts: gptEfforts }),
    model({ id: "anthropic/claude-sonnet-5-5", agent: "claude-code", providerId: "xd", providerName: "Cindy AI", efforts: gptEfforts }),
  ];
}

/** Pre-redesign Claude profile: inherit sol, no direction_route. */
export function legacyGrokInheritManual(): ModelManual {
  const sol = cloneManual(DEFAULT_MANUAL).profiles.find((p) => p.id === "sol")!;
  return {
    version: 1,
    profiles: [
      sol,
      {
        id: "grok",
        name: "grok 主控",
        harness: "claude-code",
        lead: { agent: "claude-code", model: "grok-4.6", provider_id: "art-cindy", effort: "high" },
        direction_gate: "astra",
        inherit: "sol",
        nodes: {},
      },
    ],
    defaults_by_harness: { codex: "sol", "claude-code": "grok" },
  };
}

function setPrimary(manual: ModelManual, profileId: string, taskType: TaskType, role: Role, route: Route): void {
  const profile = manual.profiles.find((p) => p.id === profileId)!;
  const slot = profile.nodes[taskType]![role]!;
  (slot as { primary: Route }).primary = route;
}

function kvOfByteSize(size: number, extra: Record<string, unknown> = {}): { kv: Record<string, unknown>; bytes: number } {
  const kv: Record<string, unknown> = { manual: DEFAULT_MANUAL, ...extra, pad: "" };
  const bytes = () => new TextEncoder().encode(JSON.stringify(kv)).length;
  const delta = size - bytes();
  kv.pad = delta > 0 ? "x".repeat(delta) : "";
  while (bytes() < size) kv.pad = `${kv.pad as string}x`;
  while (bytes() > size && (kv.pad as string).length) kv.pad = (kv.pad as string).slice(0, -1);
  return { kv, bytes: bytes() };
}

describe("Appendix C defaults", () => {
  it("validate against a stub catalog that contains every Appendix C model", () => {
    const issues = validateManual(DEFAULT_MANUAL, appendixCAgentModels(), { manual: DEFAULT_MANUAL });
    expect(issues).toEqual([]);
  });

  it("Sol 主控 is the Codex default; grok 主控 is an independent Claude profile", () => {
    expect(resolveProfileForHarness(DEFAULT_MANUAL, "codex")).toMatchObject({ id: "sol", harness: "codex", name: "Sol 主控" });
    const grok = resolveProfileForHarness(DEFAULT_MANUAL, "claude-code");
    expect(grok).toMatchObject({ id: "grok", harness: "claude-code" });
    expect(grok.inherit).toBeUndefined();
    expect(grok.direction_gate).toBe("astra");
    expect(grok.direction_route).toEqual({ agent: "claude-code", model: "anthropic/claude-opus-5-5", provider_id: "xd", effort: "xhigh" });
    expect(grok.lead).toEqual({ agent: "claude-code", model: "grok-4.6", provider_id: "art-cindy", effort: "high" });
    expect(grok.nodes.default?.explorer?.primary).toEqual({ agent: "claude-code", model: "anthropic/claude-haiku-5-5", provider_id: "xd", effort: "medium" });
    expect(grok.nodes.default?.researcher?.primary).toEqual({ agent: "claude-code", model: "anthropic/claude-haiku-5-5", provider_id: "xd", effort: "high" });
    expect(grok.nodes.default?.worker?.primary).toEqual({ agent: "claude-code", model: "anthropic/claude-sonnet-5-5", provider_id: "xd", effort: "high" });
    expect(grok.nodes.default?.verifier?.primary).toEqual({ agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy", effort: "high" });
    expect(grok.nodes.default?.architect?.primary).toEqual({ agent: "claude-code", model: "anthropic/claude-opus-5-5", provider_id: "xd", effort: "xhigh" });
    expect(family(grok.nodes.default!.verifier!.primary.model)).not.toBe("claude");
    expect(() => resolveProfileForHarness(DEFAULT_MANUAL, "pi")).toThrow(KeelError);
  });

  it("Codex defaults keep the recommended five slots and 主控自己定", () => {
    const sol = resolveProfileForHarness(DEFAULT_MANUAL, "codex");
    expect(sol.direction_gate).toBe("lead");
    expect(sol.direction_route).toBeUndefined();
    expect(sol.lead).toEqual({ agent: "codex", model: "gpt-6.1-sol", provider_id: "art-cindy", effort: "high" });
    expect(sol.nodes.default?.explorer?.primary).toMatchObject({ model: "gpt-6-luna", effort: "medium" });
    expect(sol.nodes.default?.researcher?.primary).toMatchObject({ model: "gpt-6-luna", effort: "high" });
    expect(sol.nodes.default?.worker?.primary).toMatchObject({ agent: "pi", model: "grok-4.6", effort: "high" });
    expect(sol.nodes.default?.verifier?.primary).toMatchObject({ model: "gpt-6-luna", effort: "high" });
    expect(sol.nodes.default?.architect?.primary).toMatchObject({ model: "gpt-6-astra", effort: "xhigh" });
  });

  it("mutating sol slots does not change grok defaults", () => {
    const manual = cloneManual(DEFAULT_MANUAL);
    (manual.profiles[0]!.nodes.default!.explorer as { primary: Route }).primary = { agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy", effort: "low" };
    expect(DEFAULT_MANUAL.profiles.find((p) => p.id === "grok")!.nodes.default!.explorer!.primary.effort).toBe("medium");
    expect(resolve(manual, "grok", "default", "explorer").primary.effort).toBe("medium");
  });
});

describe("resolve fallback order", () => {
  it("uses nodes[taskType][role], then nodes.default[role], then inherit", () => {
    const manual = legacyGrokInheritManual();
    const sol = manual.profiles[0] as Profile;
    (sol as { nodes: Profile["nodes"] }).nodes = {
      ...sol.nodes,
      "bug-fix": {
        explorer: {
          primary: { agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy", effort: "low" },
        },
      },
    };
    expect(resolve(manual, "sol", "bug-fix", "explorer").primary.effort).toBe("low");
    expect(resolve(manual, "sol", "bug-fix", "worker").primary).toMatchObject({ model: "grok-4.6", agent: "pi" });
    expect(resolve(manual, "grok", "bug-fix", "explorer").primary.effort).toBe("low");
    expect(resolve(manual, "grok", "feature", "architect").primary).toMatchObject({ model: "gpt-6-astra", effort: "xhigh" });
    expect(resolve(manual, "sol", "default", "verifier").fallbacks).toEqual([
      { agent: "codex", model: "openai/gpt-6-luna", provider_id: "xd", effort: "high" },
    ]);
  });

  it("throws with a diagnostic on unknown profile, dangling inherit, cycle, and missing slot", () => {
    expect(() => resolve(DEFAULT_MANUAL, "missing", "default", "worker")).toThrow(expect.objectContaining({ code: "PROFILE_UNKNOWN", data: { path: "profiles/missing" } }));

    const dangling = legacyGrokInheritManual();
    (dangling.profiles[1] as { inherit: string }).inherit = "gone";
    expect(() => resolve(dangling, "grok", "default", "worker")).toThrow(expect.objectContaining({ code: "MANUAL_INHERIT_MISSING" }));

    const lead = { agent: "codex" as const, model: "gpt-6.1-sol", provider_id: "art-cindy" };
    const cyclic: ModelManual = {
      version: 1,
      profiles: [
        { id: "a", name: "a", harness: "codex", lead, direction_gate: "lead", inherit: "b", nodes: {} },
        { id: "b", name: "b", harness: "codex", lead, direction_gate: "lead", inherit: "a", nodes: {} },
      ],
      defaults_by_harness: {},
    };
    expect(() => resolve(cyclic, "a", "default", "worker")).toThrow(expect.objectContaining({ code: "MANUAL_INHERIT_CYCLE" }));

    const empty: ModelManual = { version: 1, profiles: [{ id: "solo", name: "x", harness: "codex", lead: { agent: "codex", model: "gpt-6.1-sol", provider_id: "art-cindy" }, direction_gate: "lead", nodes: {} }], defaults_by_harness: {} };
    expect(() => resolve(empty, "solo", "default", "worker")).toThrow(expect.objectContaining({ code: "MANUAL_SLOT_UNRESOLVED" }));
  });
});

describe("validateManual", () => {
  it("rejects an unknown model and an effort outside the declared list", () => {
    const manual = cloneManual(DEFAULT_MANUAL);
    (manual.profiles[0]!.nodes.default!.worker as { primary: { model: string } }).primary.model = "no-such-model";
    const unknown = validateManual(manual, appendixCAgentModels(), { manual });
    expect(unknown.some((i) => i.path.includes("worker/primary") && i.message.includes("不存在"))).toBe(true);

    const effort = cloneManual(DEFAULT_MANUAL);
    (effort.profiles[0]!.nodes.default!.worker as { primary: { effort: string } }).primary.effort = "ultra";
    const issues = validateManual(effort, appendixCAgentModels(), { manual: effort });
    expect(issues.some((i) => i.path.includes("effort") && i.message.includes("ultra"))).toBe(true);
  });

  it("empty efforts means undeclared: only a missing effort is accepted", () => {
    const models = [
      ...appendixCAgentModels(),
      model({ id: "plain", agent: "codex", providerId: "art-cindy", efforts: [] }),
    ];
    const withEffort = cloneManual(DEFAULT_MANUAL);
    setPrimary(withEffort, "sol", "default", "explorer", { agent: "codex", model: "plain", provider_id: "art-cindy", effort: "high" });
    expect(validateManual(withEffort, models, { manual: withEffort }).some((i) => i.message.includes("未声明档位"))).toBe(true);

    const noEffort = cloneManual(DEFAULT_MANUAL);
    setPrimary(noEffort, "sol", "default", "explorer", { agent: "codex", model: "plain", provider_id: "art-cindy" });
    expect(validateManual(noEffort, models, { manual: noEffort }).some((i) => i.path.includes("explorer"))).toBe(false);
  });

  it("rejects Verifier and Worker of the same family, including gpt-6-luna vs openai/gpt-6-luna", () => {
    const same = cloneManual(DEFAULT_MANUAL);
    (same.profiles[0]!.nodes.default!.verifier as { primary: { agent: string; model: string; provider_id: string; effort: string } }).primary = {
      agent: "pi",
      model: "grok-4.6",
      provider_id: "art-cindy",
      effort: "high",
    };
    expect(validateManual(same, appendixCAgentModels(), { manual: same }).some((i) => i.message.includes("同模型族"))).toBe(true);

    const prefixed = cloneManual(DEFAULT_MANUAL);
    (prefixed.profiles[0]!.nodes.default!.worker as { primary: { agent: string; model: string; provider_id: string; effort: string } }).primary = {
      agent: "codex",
      model: "gpt-6-luna",
      provider_id: "art-cindy",
      effort: "high",
    };
    (prefixed.profiles[0]!.nodes.default!.verifier as { primary: { agent: string; model: string; provider_id: string; effort: string } }).primary = {
      agent: "codex",
      model: "openai/gpt-6-luna",
      provider_id: "xd",
      effort: "high",
    };
    expect(validateManual(prefixed, appendixCAgentModels(), { manual: prefixed }).some((i) => i.message.includes("同模型族"))).toBe(true);
  });

  it("rejects inherit cycles, dangling refs, and harness-default mismatch", () => {
    const cyclic = legacyGrokInheritManual();
    (cyclic.profiles[0] as { inherit?: string }).inherit = "grok";
    (cyclic.profiles[1] as { inherit: string }).inherit = "sol";
    expect(validateManual(cyclic, appendixCAgentModels(), { manual: cyclic }).some((i) => i.message.includes("循环"))).toBe(true);

    const dangling = legacyGrokInheritManual();
    (dangling.profiles[1] as { inherit: string }).inherit = "gone";
    expect(validateManual(dangling, appendixCAgentModels(), { manual: dangling }).some((i) => i.message.includes("不存在的方案"))).toBe(true);

    const mismatch = cloneManual(DEFAULT_MANUAL);
    (mismatch.defaults_by_harness as { codex: string }).codex = "grok";
    expect(validateManual(mismatch, appendixCAgentModels(), { manual: mismatch }).some((i) => i.path === "defaults_by_harness/codex" && i.message.includes("不匹配"))).toBe(true);
  });

  it("measures the full /kv object: 64KB is accepted, one byte over is rejected", () => {
    const models = appendixCAgentModels();
    const atLimit = kvOfByteSize(KV_MAX_BYTES);
    expect(atLimit.bytes).toBe(KV_MAX_BYTES);
    expect(validateManual(DEFAULT_MANUAL, models, atLimit.kv).some((i) => i.path === "/kv")).toBe(false);

    const over = kvOfByteSize(KV_MAX_BYTES + 1);
    expect(over.bytes).toBe(KV_MAX_BYTES + 1);
    const issues = validateManual(DEFAULT_MANUAL, models, over.kv);
    expect(issues.some((i) => i.path === "/kv" && i.message.includes("超过") && !i.message.includes("sk-") && !i.message.includes("token"))).toBe(true);
  });

  it("export then import yields the same content", () => {
    expect(importManual(exportManual(DEFAULT_MANUAL))).toEqual(DEFAULT_MANUAL);
  });

  it("parses old JSON without direction_route and keeps inherit", () => {
    const parsed = parseManual(legacyGrokInheritManual());
    expect(parsed.profiles[1]).toMatchObject({ id: "grok", inherit: "sol" });
    expect(parsed.profiles[1]!.direction_route).toBeUndefined();
    expect("direction_route" in parsed.profiles[1]!).toBe(false);
  });

  it("parses and validates direction_route; rejects bad effort", () => {
    const raw = cloneManual(DEFAULT_MANUAL);
    const parsed = parseManual({
      ...raw,
      profiles: raw.profiles.map((p) => p.id === "sol" ? { ...p, direction_route: { agent: "codex", model: "gpt-6-astra", provider_id: "art-cindy", effort: "xhigh" } } : p),
    });
    expect(parsed.profiles[0]!.direction_route).toEqual({ agent: "codex", model: "gpt-6-astra", provider_id: "art-cindy", effort: "xhigh" });
    expect(validateManual(parsed, appendixCAgentModels(), { manual: parsed })).toEqual([]);

    const bad = cloneManual(parsed);
    (bad.profiles[0] as { direction_route: Route }).direction_route = { agent: "codex", model: "gpt-6-astra", provider_id: "art-cindy", effort: "ultra" };
    expect(validateManual(bad, appendixCAgentModels(), { manual: bad }).some((i) => i.path.includes("direction_route") && i.message.includes("ultra"))).toBe(true);

    expect(() => parseManual({
      ...raw,
      profiles: raw.profiles.map((p) => p.id === "sol" ? { ...p, direction_route: { agent: "codex" } } : p),
    })).toThrow(expect.objectContaining({ code: "MANUAL_INVALID", path: expect.stringContaining("direction_route") }));
  });
});

describe("resolveDirection", () => {
  it("uses direction_route when present and otherwise the architect slot including inherit", () => {
    expect(resolveDirection(DEFAULT_MANUAL, "sol", "default").primary).toMatchObject({ model: "gpt-6-astra", effort: "xhigh" });
    expect(resolveDirection(DEFAULT_MANUAL, "grok", "default").primary).toEqual({
      agent: "claude-code", model: "anthropic/claude-opus-5-5", provider_id: "xd", effort: "xhigh",
    });
    expect(resolveDirection(DEFAULT_MANUAL, "grok", "default").fallbacks).toEqual([]);

    const inherited = legacyGrokInheritManual();
    expect(resolveDirection(inherited, "grok", "feature").primary).toMatchObject({ model: "gpt-6-astra" });
    expect(resolveDirection(inherited, "grok", "bug-fix").fallbacks.length).toBeGreaterThan(0);

    const tasked = cloneManual(DEFAULT_MANUAL);
    (tasked.profiles[0] as { nodes: Profile["nodes"] }).nodes = {
      ...tasked.profiles[0]!.nodes,
      feature: {
        architect: { primary: { agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy", effort: "high" } },
      },
    };
    expect(resolveDirection(tasked, "sol", "feature").primary.model).toBe("gpt-6-luna");
  });
});
