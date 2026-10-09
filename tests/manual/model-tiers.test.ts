import { describe, expect, it } from "vitest";
import { directionOptions, modelTier } from "../../src/shared/manual/model-tiers.ts";
import type { AgentModel } from "../../src/shared/manual/schema.ts";

function m(partial: Partial<AgentModel> & Pick<AgentModel, "id" | "agent" | "providerId">): AgentModel {
  return { visible: true, name: partial.id, ...partial };
}

describe("modelTier", () => {
  it("ranks TOP before MID before LOW, including prefixed ids", () => {
    expect(modelTier("gpt-6.1-sol")).toBe(1);
    expect(modelTier("openai/gpt-6-astra")).toBe(1);
    expect(modelTier("anthropic/claude-opus-5-5")).toBe(1);
    expect(modelTier("gpt-6-luna")).toBe(2);
    expect(modelTier("openai/gpt-6-luna")).toBe(2);
    expect(modelTier("grok-4.6")).toBe(2);
    expect(modelTier("anthropic/claude-sonnet-5-5")).toBe(2);
    expect(modelTier("anthropic/claude-haiku-5-5")).toBe(3);
    expect(modelTier("gpt-5.4-mini")).toBe(3);
    expect(modelTier("totally-unknown-model")).toBe(0);
  });
});

describe("directionOptions", () => {
  const catalog: AgentModel[] = [
    m({ id: "gpt-6.1-sol", agent: "codex", providerId: "art-cindy", providerName: "Art Cindy" }),
    m({ id: "gpt-6-astra", agent: "codex", providerId: "art-cindy", providerName: "Art Cindy" }),
    m({ id: "gpt-6-luna", agent: "codex", providerId: "art-cindy", providerName: "Art Cindy" }),
    m({ id: "openai/gpt-6-luna", agent: "codex", providerId: "xd", providerName: "Cindy AI" }),
    m({ id: "anthropic/claude-haiku-5-5", agent: "claude-code", providerId: "xd", providerName: "Cindy AI" }),
    m({ id: "mystery", agent: "codex", providerId: "art-cindy" }),
    m({ id: "gpt-6-luna", agent: "codex", providerId: "art-cindy", providerName: "Art Cindy" }), // dup
    { id: "hidden-strong", agent: "codex", providerId: "art-cindy", visible: false },
    { id: "no-flag", agent: "codex", providerId: "art-cindy" },
  ];

  it("hides weaker models and counts unique visible triples for the current agent", () => {
    const set = directionOptions(catalog, "codex", "gpt-6.1-sol");
    expect(set.stronger).toBe(0);
    expect(set.equal).toBe(2); // sol + astra, both TOP
    expect(set.ungraded).toBe(1); // mystery
    expect(set.hiddenWeaker).toBe(2); // luna art-cindy + luna xd
    expect(set.groups.some((g) => g.options.some((o) => o.id === "gpt-6-luna"))).toBe(false);
    expect(set.groups.some((g) => g.options.some((o) => o.id === "hidden-strong" || o.id === "no-flag"))).toBe(false);
    expect(set.groups.some((g) => g.label.includes("Cindy AI") || g.label.includes("Art Cindy"))).toBe(true);
  });

  it("puts every known model in 未分级 when the lead is ungraded", () => {
    const set = directionOptions(catalog, "codex", "totally-unknown-model");
    expect(set.hiddenWeaker).toBe(0);
    expect(set.ungraded).toBe(5);
    expect(set.stronger).toBe(0);
    expect(set.equal).toBe(0);
    expect(set.groups.every((g) => g.key === "ungraded")).toBe(true);
  });
});
