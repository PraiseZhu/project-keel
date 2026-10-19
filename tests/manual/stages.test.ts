import { describe, expect, it } from "vitest";
import { cloneManual, DEFAULT_MANUAL, type AgentModel, type ModelManual, type Profile, type Route } from "../../src/shared/manual/schema.ts";
import {
  allowedHarnesses,
  blockedReason,
  isStageHarness,
  LEAD_DEFAULT_PROVIDER,
  otherHarness,
  readStages,
  RESEARCH_PARALLEL,
  RESEARCH_SUB,
  setCodeRoutes,
  setPlanRoute,
  setReviewRoutes,
  stageModelAllowed,
  stripRetiredFields,
} from "../../src/shared/manual/stages.ts";

const opus: Route = { agent: "claude-code", model: "anthropic/claude-opus-5-5", provider_id: "xd", effort: "xhigh" };
const sonnet: Route = { agent: "claude-code", model: "anthropic/claude-sonnet-5-5", provider_id: "xd", effort: "high" };
const astra: Route = { agent: "codex", model: "gpt-6-astra", provider_id: "art-cindy", effort: "xhigh" };

function row(partial: Partial<AgentModel> & Pick<AgentModel, "id" | "agent" | "providerId">): AgentModel {
  return { visible: true, efforts: ["high"], ...partial };
}

describe("stage constants", () => {
  it("查资料 is the lead's own sub: haiku for Claude Code, gpt-6-luna for Codex, three in parallel", () => {
    expect(RESEARCH_SUB["claude-code"].model).toBe("haiku");
    expect(RESEARCH_SUB.codex.model).toBe("gpt-6-luna");
    expect(RESEARCH_PARALLEL).toBe(3);
    expect(LEAD_DEFAULT_PROVIDER).toBe("lead-default");
    expect(RESEARCH_SUB["claude-code"].note).toMatch(/model=haiku/);
    expect(RESEARCH_SUB.codex.note).toMatch(/gpt-6-luna/);
  });

  it("only Claude Code and Codex are stage harnesses", () => {
    expect(isStageHarness("claude-code")).toBe(true);
    expect(isStageHarness("codex")).toBe(true);
    expect(isStageHarness("pi")).toBe(false);
    expect(isStageHarness(undefined)).toBe(false);
    expect(otherHarness("codex")).toBe("claude-code");
    expect(otherHarness("claude-code")).toBe("codex");
  });
});

describe("blockedReason", () => {
  it("rejects Pi and unknown harnesses", () => {
    expect(blockedReason("pi", "art-cindy", "grok-4.6")).toMatch(/Pi/);
    expect(blockedReason("gemini", "xd", "x")).toMatch(/不支持的执行框架 gemini/);
  });

  it("rejects Claude Code on Art Cindy GPT models only", () => {
    expect(blockedReason("claude-code", "art-cindy", "gpt-6-astra")).toMatch(/403/);
    expect(blockedReason("claude-code", "art-cindy", "GPT-6-Astra")).toMatch(/403/);
    expect(blockedReason("claude-code", "art-cindy", "grok-4.6")).toBeUndefined();
    expect(blockedReason("claude-code", "xd", "openai/gpt-6-astra")).toBeUndefined();
    expect(blockedReason("codex", "art-cindy", "gpt-6-astra")).toBeUndefined();
  });
});

describe("allowedHarnesses / stageModelAllowed", () => {
  it("想方案 takes the other harness than the lead; 做检查 the other than the writer; 写代码 either", () => {
    expect(allowedHarnesses("plan", "codex")).toEqual(["claude-code"]);
    expect(allowedHarnesses("plan", "claude-code")).toEqual(["codex"]);
    expect(allowedHarnesses("review", "codex", "codex")).toEqual(["claude-code"]);
    expect(allowedHarnesses("review", "codex", "claude-code")).toEqual(["codex"]);
    expect(allowedHarnesses("review", "codex")).toEqual(["claude-code", "codex"]);
    expect(allowedHarnesses("review", "codex", "pi")).toEqual(["claude-code", "codex"]);
    expect(allowedHarnesses("code", "codex")).toEqual(["claude-code", "codex"]);
  });

  it("filters hidden, blocked and wrong-harness catalog rows", () => {
    const opusRow = row({ id: opus.model, agent: "claude-code", providerId: "xd" });
    const astraRow = row({ id: astra.model, agent: "codex", providerId: "art-cindy" });
    expect(stageModelAllowed("plan", opusRow, "codex")).toBe(true);
    expect(stageModelAllowed("plan", astraRow, "codex")).toBe(false);
    expect(stageModelAllowed("review", astraRow, "claude-code", "claude-code")).toBe(true);
    expect(stageModelAllowed("review", opusRow, "claude-code", "claude-code")).toBe(false);
    expect(stageModelAllowed("code", { ...opusRow, visible: false }, "codex")).toBe(false);
    expect(stageModelAllowed("code", row({ id: "gpt-6-astra", agent: "claude-code", providerId: "art-cindy" }), "codex")).toBe(false);
    expect(stageModelAllowed("code", row({ id: "grok-4.6", agent: "pi", providerId: "art-cindy" }), "codex")).toBe(false);
  });
});

describe("readStages / setters", () => {
  it("reads the default profiles' stage routes", () => {
    expect(readStages(DEFAULT_MANUAL, "sol")).toMatchObject({
      plan: opus,
      code: { primary: { agent: "codex", model: "gpt-6.1-sol" }, fallbacks: [{ model: "openai/gpt-6.1-sol" }] },
      review: { primary: opus, fallbacks: [{ ...sonnet, effort: "xhigh" }] },
    });
    expect(readStages(DEFAULT_MANUAL, "grok")).toMatchObject({
      plan: astra,
      code: { primary: sonnet },
      review: { primary: astra, fallbacks: [{ model: "openai/gpt-6-astra" }] },
    });
  });

  it("做检查 follows 想方案 when no explicit route exists, and unknown profiles read as empty", () => {
    const manual = cloneManual(DEFAULT_MANUAL);
    const sol = manual.profiles.find((p) => p.id === "sol") as { final_review_route?: Route; final_review_fallbacks?: Route[] };
    delete sol.final_review_route;
    delete sol.final_review_fallbacks;
    expect(readStages(manual, "sol").review).toEqual({ primary: opus, fallbacks: [] });
    expect(readStages(manual, "nope")).toEqual({ review: { fallbacks: [] } });
  });

  it("setPlanRoute replaces the architect slot, drops direction overrides, and does not mutate the input", () => {
    const manual = cloneManual(DEFAULT_MANUAL);
    const sol = manual.profiles.find((p) => p.id === "sol") as { direction_route?: Route; direction_collaborators?: Route[] };
    sol.direction_route = astra;
    sol.direction_collaborators = [astra];
    const before = JSON.stringify(manual);
    const next = setPlanRoute(manual, "sol", sonnet);
    expect(JSON.stringify(manual)).toBe(before);
    const profile = next.profiles.find((p) => p.id === "sol") as Profile;
    expect(profile.nodes.default?.architect).toEqual({ primary: sonnet });
    expect("direction_route" in profile).toBe(false);
    expect("direction_collaborators" in profile).toBe(false);
    expect(profile.nodes.default?.worker).toEqual(manual.profiles.find((p) => p.id === "sol")!.nodes.default!.worker);
    expect(next.profiles.find((p) => p.id === "grok")).toEqual(manual.profiles.find((p) => p.id === "grok"));
  });

  it("setCodeRoutes sets the writer with or without a backup", () => {
    const withBackup = setCodeRoutes(DEFAULT_MANUAL, "grok", sonnet, opus);
    expect(readStages(withBackup, "grok").code).toEqual({ primary: sonnet, fallbacks: [opus] });
    const without = setCodeRoutes(withBackup, "grok", opus);
    expect(readStages(without, "grok").code).toEqual({ primary: opus });
    expect(readStages(DEFAULT_MANUAL, "grok").code?.fallbacks).toEqual([{ ...opus, effort: "high" }]);
  });

  it("setReviewRoutes sets the explicit route and its backup, and clears stale collaborators and backups", () => {
    const manual = cloneManual(DEFAULT_MANUAL);
    (manual.profiles.find((p) => p.id === "sol") as { final_review_collaborators?: Route[] }).final_review_collaborators = [opus];
    const next = setReviewRoutes({ ...manual, version: 2 }, "sol", astra);
    const profile = next.profiles.find((p) => p.id === "sol") as Profile;
    expect(profile.final_review_route).toEqual(astra);
    expect("final_review_fallbacks" in profile).toBe(false);
    expect("final_review_collaborators" in profile).toBe(false);
    const withBackup = setReviewRoutes(next, "sol", astra, { ...astra, provider_id: "xd", model: "openai/gpt-6-astra" });
    expect(readStages(withBackup, "sol").review.fallbacks).toEqual([{ ...astra, provider_id: "xd", model: "openai/gpt-6-astra" }]);
  });
});

describe("stripRetiredFields", () => {
  it("keeps only the default column and drops every collaborator list", () => {
    const manual = cloneManual(DEFAULT_MANUAL) as { -readonly [K in keyof ModelManual]: ModelManual[K] };
    const sol = manual.profiles.find((p) => p.id === "sol") as { nodes: Profile["nodes"]; direction_collaborators?: Route[]; final_review_collaborators?: Route[] };
    sol.direction_collaborators = [astra];
    sol.final_review_collaborators = [astra];
    sol.nodes = {
      default: { ...sol.nodes.default, architect: { primary: opus, collaborators: [astra] }, explorer: { primary: sonnet } },
      "bug-fix": { worker: { primary: sonnet } },
      feature: { architect: { primary: astra } },
    };
    const stripped = stripRetiredFields(manual);
    const profile = stripped.profiles.find((p) => p.id === "sol") as Profile;
    expect(Object.keys(profile.nodes)).toEqual(["default"]);
    expect(profile.nodes.default?.architect).toEqual({ primary: opus });
    expect(profile.nodes.default?.explorer).toEqual({ primary: sonnet });
    expect("direction_collaborators" in profile).toBe(false);
    expect("final_review_collaborators" in profile).toBe(false);
    expect(profile.final_review_route).toEqual(opus);
  });

  it("gives a profile without a default column an empty node table", () => {
    const manual: ModelManual = {
      version: 1,
      profiles: [{ id: "x", name: "x", harness: "codex", lead: { agent: "codex", model: "gpt-6.1-sol", provider_id: "art-cindy" }, direction_gate: "lead", nodes: { feature: { worker: { primary: sonnet } } } }],
      defaults_by_harness: {},
    };
    expect(stripRetiredFields(manual).profiles[0]!.nodes).toEqual({});
  });
});
