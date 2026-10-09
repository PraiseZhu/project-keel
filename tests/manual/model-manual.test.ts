import { describe, expect, it } from "vitest";
import { KeelError } from "../../src/main/host.ts";
import { resolve, resolveProfileForHarness } from "../../src/main/manual/resolve.ts";
import {
  cloneManual,
  DEFAULT_MANUAL,
  exportManual,
  importManual,
  KV_MAX_BYTES,
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
  ];
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

  it("Sol 主控 is the Codex default; grok 主控 inherits it", () => {
    expect(resolveProfileForHarness(DEFAULT_MANUAL, "codex")).toMatchObject({ id: "sol", harness: "codex", name: "Sol 主控" });
    expect(resolveProfileForHarness(DEFAULT_MANUAL, "claude-code")).toMatchObject({ id: "grok", harness: "claude-code", inherit: "sol" });
    expect(() => resolveProfileForHarness(DEFAULT_MANUAL, "pi")).toThrow(KeelError);
  });
});

describe("resolve fallback order", () => {
  it("uses nodes[taskType][role], then nodes.default[role], then inherit", () => {
    const manual = cloneManual(DEFAULT_MANUAL);
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

    const dangling = cloneManual(DEFAULT_MANUAL);
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
    const cyclic = cloneManual(DEFAULT_MANUAL);
    (cyclic.profiles[0] as { inherit?: string }).inherit = "grok";
    (cyclic.profiles[1] as { inherit: string }).inherit = "sol";
    expect(validateManual(cyclic, appendixCAgentModels(), { manual: cyclic }).some((i) => i.message.includes("循环"))).toBe(true);

    const dangling = cloneManual(DEFAULT_MANUAL);
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
});
