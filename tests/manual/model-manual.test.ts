import { describe, expect, it } from "vitest";
import { KeelError } from "../../src/main/host.ts";
import { resolve, resolveProfileForHarness } from "../../src/main/manual/resolve.ts";
import { family } from "../../src/shared/fanout.ts";
import { resolveDirection, resolveFinalReview } from "../../src/shared/manual/resolve.ts";
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

/** Stub /agent-models covering every default route id × agent × provider (plus the extra rows other tests reuse). */
export function appendixCAgentModels(): AgentModel[] {
  return [
    model({ id: "gpt-6.1-sol", agent: "codex", providerId: "art-cindy", providerName: "Art Cindy", efforts: gptEfforts }),
    model({ id: "openai/gpt-6.1-sol", agent: "codex", providerId: "xd", providerName: "XD", efforts: gptEfforts }),
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

/** Claude profile that inherits sol's slots and has no direction_route / final_review_route of its own. */
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

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function profileOf(manual: ModelManual, id: string): Mutable<Profile> {
  return manual.profiles.find((p) => p.id === id) as Mutable<Profile>;
}

function setPrimary(manual: ModelManual, profileId: string, taskType: TaskType, role: Role, route: Route): void {
  const profile = manual.profiles.find((p) => p.id === profileId)!;
  const slot = profile.nodes[taskType]![role]!;
  (slot as { primary: Route }).primary = route;
}

/** A manual whose sol profile has the given stage routes; everything else stays at the defaults. */
function solWith(edit: (sol: Mutable<Profile>) => void): ModelManual {
  const manual = cloneManual(DEFAULT_MANUAL);
  edit(profileOf(manual, "sol"));
  return manual;
}

function issuesOf(manual: ModelManual, models: readonly AgentModel[] = appendixCAgentModels()) {
  return validateManual(manual, models, { manual });
}

const codexAstra: Route = { agent: "codex", model: "gpt-6-astra", provider_id: "art-cindy", effort: "xhigh" };
const claudeOpus: Route = { agent: "claude-code", model: "anthropic/claude-opus-5-5", provider_id: "xd", effort: "xhigh" };
const claudeSonnet: Route = { agent: "claude-code", model: "anthropic/claude-sonnet-5-5", provider_id: "xd", effort: "xhigh" };

function kvOfByteSize(size: number, extra: Record<string, unknown> = {}): { kv: Record<string, unknown>; bytes: number } {
  const kv: Record<string, unknown> = { manual: DEFAULT_MANUAL, ...extra, pad: "" };
  const bytes = () => new TextEncoder().encode(JSON.stringify(kv)).length;
  const delta = size - bytes();
  kv.pad = delta > 0 ? "x".repeat(delta) : "";
  while (bytes() < size) kv.pad = `${kv.pad as string}x`;
  while (bytes() > size && (kv.pad as string).length) kv.pad = (kv.pad as string).slice(0, -1);
  return { kv, bytes: bytes() };
}

describe("four-stage defaults", () => {
  it("validate against a stub catalog that contains every default route", () => {
    expect(validateManual(DEFAULT_MANUAL, appendixCAgentModels(), { manual: DEFAULT_MANUAL })).toEqual([]);
  });

  it("Codex 主控 (sol): 想方案 and 做检查 on Claude Code, 写代码 on Codex with an XD backup", () => {
    const sol = resolveProfileForHarness(DEFAULT_MANUAL, "codex");
    expect(sol).toMatchObject({ id: "sol", harness: "codex", name: "Codex 主控", direction_gate: "lead" });
    expect(sol.inherit).toBeUndefined();
    expect(sol.direction_route).toBeUndefined();
    expect(sol.nodes.default?.architect).toEqual({ primary: claudeOpus });
    expect(sol.nodes.default?.worker).toEqual({
      primary: { agent: "codex", model: "gpt-6.1-sol", provider_id: "art-cindy", effort: "high" },
      fallbacks: [{ agent: "codex", model: "openai/gpt-6.1-sol", provider_id: "xd", effort: "high" }],
    });
    expect(sol.final_review_route).toEqual(claudeOpus);
    expect(sol.final_review_fallbacks).toEqual([claudeSonnet]);
  });

  it("Claude Code 主控 (grok): 想方案 and 做检查 on Codex astra, 写代码 on Claude Code sonnet with an opus backup", () => {
    const grok = resolveProfileForHarness(DEFAULT_MANUAL, "claude-code");
    expect(grok).toMatchObject({ id: "grok", harness: "claude-code", name: "Claude Code 主控", direction_gate: "astra" });
    expect(grok.inherit).toBeUndefined();
    expect(grok.direction_route).toBeUndefined();
    expect(grok.nodes.default?.architect).toEqual({ primary: codexAstra });
    expect(grok.nodes.default?.worker).toEqual({
      primary: { agent: "claude-code", model: "anthropic/claude-sonnet-5-5", provider_id: "xd", effort: "high" },
      fallbacks: [{ agent: "claude-code", model: "anthropic/claude-opus-5-5", provider_id: "xd", effort: "high" }],
    });
    expect(grok.final_review_route).toEqual(codexAstra);
    expect(grok.final_review_fallbacks).toEqual([{ agent: "codex", model: "openai/gpt-6-astra", provider_id: "xd", effort: "xhigh" }]);
    expect(() => resolveProfileForHarness(DEFAULT_MANUAL, "pi")).toThrow(KeelError);
  });

  it("has no explorer / researcher / verifier slots, no task-type columns, and no collaborators", () => {
    expect(DEFAULT_MANUAL.version).toBe(2);
    for (const profile of DEFAULT_MANUAL.profiles) {
      expect(Object.keys(profile.nodes), profile.id).toEqual(["default"]);
      expect(Object.keys(profile.nodes.default!).sort(), profile.id).toEqual(["architect", "worker"]);
      expect(profile.direction_collaborators, profile.id).toBeUndefined();
      expect(profile.final_review_collaborators, profile.id).toBeUndefined();
      expect(profile.nodes.default!.worker!.collaborators, profile.id).toBeUndefined();
    }
  });

  it("keeps the stage invariants the validator enforces: 想方案 off the lead's harness, 做检查 off the writer's harness and family", () => {
    for (const profile of DEFAULT_MANUAL.profiles) {
      const plan = resolve(DEFAULT_MANUAL, profile.id, "default", "architect");
      const code = resolve(DEFAULT_MANUAL, profile.id, "default", "worker");
      const review = resolveFinalReview(DEFAULT_MANUAL, profile.id, "default");
      expect(plan.primary.agent, `${profile.id} plan`).not.toBe(profile.harness);
      for (const route of code.fallbacks) expect(route.agent, `${profile.id} code backup`).toBe(code.primary.agent);
      for (const route of [review.primary, ...review.fallbacks]) {
        expect(route.agent, `${profile.id} review`).not.toBe(code.primary.agent);
        expect(family(route.model), `${profile.id} review`).not.toBe(family(code.primary.model));
      }
    }
  });

  it("mutating sol slots does not change grok defaults", () => {
    const manual = cloneManual(DEFAULT_MANUAL);
    const solWorker = profileOf(manual, "sol").nodes.default!.worker as { primary: Route };
    solWorker.primary = { ...solWorker.primary, effort: "low" };
    expect(resolve(manual, "sol", "default", "worker").primary.effort).toBe("low");
    expect(resolve(manual, "grok", "default", "worker").primary.effort).toBe("high");
    expect(resolve(DEFAULT_MANUAL, "sol", "default", "worker").primary.effort).toBe("high");
  });
});

describe("resolve", () => {
  it("reads only nodes.default (then inherit); per-task-type columns are ignored", () => {
    const manual = legacyGrokInheritManual();
    const sol = profileOf(manual, "sol");
    sol.nodes = {
      ...sol.nodes,
      "bug-fix": { worker: { primary: { agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy", effort: "low" } } },
      feature: { architect: { primary: codexAstra } },
    };
    const worker = resolve(manual, "sol", "default", "worker");
    expect(worker.primary).toMatchObject({ model: "gpt-6.1-sol", effort: "high" });
    expect(resolve(manual, "sol", "bug-fix", "worker")).toEqual(worker);
    expect(resolve(manual, "grok", "bug-fix", "worker")).toEqual(worker);
    expect(resolve(manual, "sol", "feature", "architect").primary).toEqual(claudeOpus);
    expect(resolve(manual, "grok", "feature", "architect").primary).toEqual(claudeOpus);
    expect(worker.fallbacks).toEqual([{ agent: "codex", model: "openai/gpt-6.1-sol", provider_id: "xd", effort: "high" }]);
  });

  it("does not resolve a slot that only exists in a task-type column", () => {
    const lead = { agent: "codex" as const, model: "gpt-6.1-sol", provider_id: "art-cindy" };
    const manual: ModelManual = {
      version: 2,
      profiles: [{
        id: "solo", name: "x", harness: "codex", lead, direction_gate: "lead",
        nodes: { "bug-fix": { worker: { primary: { agent: "codex", model: "gpt-6.1-sol", provider_id: "art-cindy" } } } },
      }],
      defaults_by_harness: {},
    };
    expect(() => resolve(manual, "solo", "bug-fix", "worker")).toThrow(expect.objectContaining({ code: "MANUAL_SLOT_UNRESOLVED" }));
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
    setPrimary(withEffort, "sol", "default", "worker", { agent: "codex", model: "plain", provider_id: "art-cindy", effort: "high" });
    expect(validateManual(withEffort, models, { manual: withEffort }).some((i) => i.message.includes("未声明档位"))).toBe(true);

    const noEffort = cloneManual(DEFAULT_MANUAL);
    setPrimary(noEffort, "sol", "default", "worker", { agent: "codex", model: "plain", provider_id: "art-cindy" });
    expect(validateManual(noEffort, models, { manual: noEffort }).some((i) => i.path.includes("worker/primary"))).toBe(false);
  });

  it("想方案 must run on the other harness than the lead", () => {
    const sameAsLead = solWith((sol) => {
      sol.nodes = { default: { ...sol.nodes.default, architect: { primary: codexAstra } } };
    });
    const issues = issuesOf(sameAsLead);
    expect(issues.some((i) => i.path === "profiles/sol/nodes/default/architect/primary" && i.message.includes("想方案要换一家"))).toBe(true);

    const claudeLead = cloneManual(DEFAULT_MANUAL);
    profileOf(claudeLead, "grok").nodes = { default: { ...profileOf(claudeLead, "grok").nodes.default, architect: { primary: claudeOpus } } };
    expect(issuesOf(claudeLead).some((i) => i.path === "profiles/grok/nodes/default/architect/primary" && i.message.includes("想方案要换一家"))).toBe(true);
  });

  it("写代码 backups must stay on the primary's harness", () => {
    const manual = solWith((sol) => {
      sol.nodes = { default: { ...sol.nodes.default, worker: { primary: sol.nodes.default!.worker!.primary, fallbacks: [claudeSonnet] } } };
    });
    expect(issuesOf(manual).some((i) => i.path === "profiles/sol/nodes/default/worker/fallbacks/0" && i.message.includes("同一家"))).toBe(true);
  });

  it("做检查 must not run on the writer's harness, primary or backup", () => {
    const primarySame = solWith((sol) => { sol.final_review_route = codexAstra; });
    expect(issuesOf(primarySame).some((i) => i.path === "profiles/sol/final_review_route" && i.message.includes("不是同一家"))).toBe(true);

    const backupSame = solWith((sol) => { sol.final_review_fallbacks = [codexAstra]; });
    expect(issuesOf(backupSame).some((i) => i.path === "profiles/sol/final_review_fallbacks/0" && i.message.includes("不是同一家"))).toBe(true);

    const noExplicit = solWith((sol) => {
      delete sol.final_review_route;
      delete sol.final_review_fallbacks;
      sol.nodes = { default: { ...sol.nodes.default, architect: { primary: codexAstra } } };
    });
    // the architect slot doubles as 做检查 when no explicit route exists; it is also wrong as 想方案 for a Codex lead
    expect(issuesOf(noExplicit).some((i) => i.message.includes("做检查要和写代码不是同一家"))).toBe(true);
  });

  it("做检查 must not share the writer's model family, including openai/ prefixed ids", () => {
    const models = [...appendixCAgentModels(), model({ id: "openai/gpt-6-astra", agent: "claude-code", providerId: "xd", efforts: gptEfforts })];
    const otherHarnessSameFamily = solWith((sol) => {
      sol.final_review_route = { agent: "claude-code", model: "openai/gpt-6-astra", provider_id: "xd", effort: "xhigh" };
      delete sol.final_review_fallbacks;
    });
    const issues = issuesOf(otherHarnessSameFamily, models);
    expect(issues.some((i) => i.path === "profiles/sol/final_review_route" && i.message.includes("同模型族"))).toBe(true);
    expect(issues.some((i) => i.message.includes("不是同一家"))).toBe(false);
  });

  it("rejects Pi and Claude Code on Art Cindy GPT routes", () => {
    const pi = solWith((sol) => {
      sol.nodes = { default: { ...sol.nodes.default, worker: { primary: { agent: "pi", model: "grok-4.6", provider_id: "art-cindy", effort: "high" } } } };
    });
    expect(issuesOf(pi).some((i) => i.path === "profiles/sol/nodes/default/worker/primary" && i.message.includes("Pi"))).toBe(true);

    const gptOnClaude = cloneManual(DEFAULT_MANUAL);
    profileOf(gptOnClaude, "grok").nodes = {
      default: { ...profileOf(gptOnClaude, "grok").nodes.default, worker: { primary: { agent: "claude-code", model: "gpt-6-astra", provider_id: "art-cindy", effort: "high" } } },
    };
    const models = [...appendixCAgentModels(), model({ id: "gpt-6-astra", agent: "claude-code", providerId: "art-cindy", efforts: gptEfforts })];
    expect(issuesOf(gptOnClaude, models).some((i) => i.path === "profiles/grok/nodes/default/worker/primary" && i.message.includes("403"))).toBe(true);
  });

  it("keeps 写代码 as a single writer", () => {
    const manual = solWith((sol) => {
      const worker = sol.nodes.default!.worker!;
      sol.nodes = { default: { ...sol.nodes.default, worker: { ...worker, collaborators: [worker.primary] } } };
    });
    expect(issuesOf(manual).some((i) => i.path === "profiles/sol/nodes/default/worker" && i.message.includes("单一写手"))).toBe(true);
  });

  it("no longer validates the lead route, explorer / researcher / verifier slots, task-type columns, or collaborators", () => {
    const unknown: Route = { agent: "codex", model: "no-such-model", provider_id: "nowhere", effort: "ultra" };
    const manual = solWith((sol) => {
      sol.lead = unknown;
      sol.direction_collaborators = [unknown];
      sol.final_review_collaborators = [unknown];
      sol.nodes = {
        default: { ...sol.nodes.default, explorer: { primary: unknown }, researcher: { primary: unknown }, verifier: { primary: unknown } },
        "bug-fix": { worker: { primary: unknown }, architect: { primary: unknown } },
        feature: { worker: { primary: unknown } },
      };
    });
    expect(issuesOf(manual)).toEqual([]);
  });

  it("validates an inheriting profile by the routes it resolves to", () => {
    const issues = issuesOf(legacyGrokInheritManual());
    expect(issues.some((i) => i.path === "profiles/grok/nodes/default/architect/primary" && i.message.includes("想方案要换一家"))).toBe(true);
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

  it("parses and validates final_review_route; omitted field is not filled in", () => {
    const raw = cloneManual(DEFAULT_MANUAL);
    const sonnetHigh: Route = { agent: "claude-code", model: "anthropic/claude-sonnet-5-5", provider_id: "xd", effort: "high" };
    const parsed = parseManual({
      ...raw,
      profiles: raw.profiles.map((p) => p.id === "sol" ? { ...p, final_review_route: sonnetHigh } : p),
    });
    expect(parsed.profiles[0]!.final_review_route).toEqual(sonnetHigh);
    expect(importManual(exportManual(parsed))).toEqual(parsed);
    expect(validateManual(parsed, appendixCAgentModels(), { manual: parsed })).toEqual([]);

    const omitted = parseManual(legacyGrokInheritManual());
    expect(omitted.profiles[1]!.final_review_route).toBeUndefined();
    expect("final_review_route" in omitted.profiles[1]!).toBe(false);

    const bad = cloneManual(parsed);
    (bad.profiles[0] as { final_review_route: Route }).final_review_route = { ...sonnetHigh, effort: "ultra" };
    expect(validateManual(bad, appendixCAgentModels(), { manual: bad }).some((i) => i.path.includes("final_review_route") && i.message.includes("ultra"))).toBe(true);

    const missing = cloneManual(parsed);
    (missing.profiles[0] as { final_review_route: Route }).final_review_route = { ...sonnetHigh, model: "no-such-model" };
    expect(validateManual(missing, appendixCAgentModels(), { manual: missing }).some((i) => i.path.includes("final_review_route") && i.message.includes("不存在"))).toBe(true);

    expect(() => parseManual({
      ...raw,
      profiles: raw.profiles.map((p) => p.id === "sol" ? { ...p, final_review_route: { agent: "codex" } } : p),
    })).toThrow(expect.objectContaining({ code: "MANUAL_INVALID", path: expect.stringContaining("final_review_route") }));
    expect(() => parseManual({
      ...raw,
      profiles: raw.profiles.map((p) => p.id === "sol" ? { ...p, final_review_route: null } : p),
    })).toThrow(expect.objectContaining({ code: "MANUAL_INVALID", path: expect.stringContaining("final_review_route") }));
  });

  it("parses final_review_fallbacks, keeps them through export/import, and requires an explicit final_review_route", () => {
    const parsed = parseManual(JSON.parse(exportManual(DEFAULT_MANUAL)));
    expect(parsed.profiles[0]!.final_review_fallbacks).toEqual([claudeSonnet]);
    expect(importManual(exportManual(parsed)).profiles[0]!.final_review_fallbacks).toEqual([claudeSonnet]);

    const raw = cloneManual(DEFAULT_MANUAL);
    expect(() => parseManual({
      ...raw,
      profiles: raw.profiles.map((p) => {
        const { final_review_route: _route, ...rest } = p;
        return p.id === "sol" ? rest : p;
      }),
    })).toThrow(expect.objectContaining({ code: "MANUAL_INVALID", path: expect.stringContaining("final_review_fallbacks") }));
    expect(() => parseManual({
      ...raw,
      profiles: raw.profiles.map((p) => p.id === "sol" ? { ...p, final_review_fallbacks: [claudeSonnet, claudeSonnet, claudeSonnet] } : p),
    })).toThrow(/最多 2/);
  });
});

describe("resolveDirection", () => {
  it("uses direction_route when present and otherwise the architect slot including inherit", () => {
    expect(resolveDirection(DEFAULT_MANUAL, "sol", "default").primary).toEqual(claudeOpus);
    expect(resolveDirection(DEFAULT_MANUAL, "grok", "default")).toEqual({ primary: codexAstra, fallbacks: [] });

    const explicit = solWith((sol) => { sol.direction_route = claudeSonnet; });
    expect(resolveDirection(explicit, "sol", "default")).toEqual({ primary: claudeSonnet, fallbacks: [] });

    const inherited = legacyGrokInheritManual();
    expect(resolveDirection(inherited, "grok", "feature").primary).toEqual(claudeOpus);
    expect(resolveDirection(inherited, "grok", "bug-fix").fallbacks).toEqual([]);
  });

  it("ignores per-task-type architect columns", () => {
    const tasked = solWith((sol) => {
      sol.nodes = { ...sol.nodes, feature: { architect: { primary: codexAstra } } };
    });
    expect(resolveDirection(tasked, "sol", "feature").primary).toEqual(claudeOpus);
  });
});

describe("resolveFinalReview", () => {
  it("returns final_review_route with its fallbacks, otherwise the architect slot including inherit", () => {
    expect(resolveFinalReview(DEFAULT_MANUAL, "sol", "default")).toEqual({ primary: claudeOpus, fallbacks: [claudeSonnet] });
    expect(resolveFinalReview(DEFAULT_MANUAL, "grok", "default")).toEqual({
      primary: codexAstra,
      fallbacks: [{ agent: "codex", model: "openai/gpt-6-astra", provider_id: "xd", effort: "xhigh" }],
    });

    const inherited = legacyGrokInheritManual();
    expect(resolveFinalReview(inherited, "grok", "feature")).toEqual(resolve(inherited, "sol", "default", "architect"));

    const omitted = solWith((sol) => {
      delete sol.final_review_route;
      delete sol.final_review_fallbacks;
    });
    expect(resolveFinalReview(omitted, "sol", "default")).toEqual(resolve(omitted, "sol", "default", "architect"));
  });

  it("ignores per-task-type architect columns", () => {
    const tasked = solWith((sol) => {
      delete sol.final_review_route;
      delete sol.final_review_fallbacks;
      sol.nodes = { ...sol.nodes, feature: { architect: { primary: codexAstra } } };
    });
    expect(resolveFinalReview(tasked, "sol", "feature").primary).toEqual(claudeOpus);
  });

  it("does not inherit a parent final_review_route", () => {
    const lead = { agent: "codex" as const, model: "gpt-6.1-sol", provider_id: "art-cindy", effort: "high" };
    const parentArch = { agent: "codex" as const, model: "gpt-6-luna", provider_id: "art-cindy", effort: "medium" };
    const manual: ModelManual = {
      version: 1,
      profiles: [
        {
          id: "parent",
          name: "parent",
          harness: "codex",
          lead,
          direction_gate: "lead",
          final_review_route: { agent: "codex", model: "gpt-6-astra", provider_id: "art-cindy", effort: "xhigh" },
          nodes: { default: { architect: { primary: parentArch } } },
        },
        {
          id: "kid",
          name: "kid",
          harness: "codex",
          lead,
          direction_gate: "lead",
          inherit: "parent",
          nodes: {},
        },
      ],
      defaults_by_harness: { codex: "parent" },
    };
    expect(resolveFinalReview(manual, "kid", "default")).toEqual({ primary: parentArch, fallbacks: [] });
    expect(resolveFinalReview(manual, "parent", "default").fallbacks).toEqual([]);
    expect(() => resolveFinalReview(DEFAULT_MANUAL, "missing", "default")).toThrow(expect.objectContaining({ code: "PROFILE_UNKNOWN" }));
  });
});
