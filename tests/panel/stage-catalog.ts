// Fixture /agent-models list for the settings page tests. It covers every route in DEFAULT_MANUAL
// plus the cases the stage dropdown rules must exclude (Pi, Claude Code + art-cindy + gpt, hidden, no efforts).
import type { AgentModel } from "../../src/shared/manual/schema.ts";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const SHORT = ["low", "medium", "high"] as const;

function entry(partial: AgentModel): AgentModel {
  return { name: partial.id, visible: true, ...partial };
}

export const XD = "XD Gateway";
export const ART = "Art Cindy";

export function stageCatalog(): AgentModel[] {
  return [
    entry({ id: "anthropic/claude-opus-5-5", name: "Opus 5.5", agent: "claude-code", providerId: "xd", providerName: XD, efforts: EFFORTS, defaultEffort: "high" }),
    entry({ id: "anthropic/claude-sonnet-5-5", name: "Sonnet 5.5", agent: "claude-code", providerId: "xd", providerName: XD, efforts: EFFORTS, defaultEffort: "medium" }),
    entry({ id: "anthropic/claude-haiku-5-5", name: "Haiku 5.5", agent: "claude-code", providerId: "xd", providerName: XD, efforts: EFFORTS }),
    entry({ id: "grok-4.6", name: "Grok 4.6", agent: "claude-code", providerId: "art-cindy", providerName: ART, efforts: SHORT, defaultEffort: "high" }),
    // Claude Code + Art Cindy + gpt-* is rejected by the gateway, so it must never be offered.
    entry({ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", agent: "claude-code", providerId: "art-cindy", providerName: ART, efforts: EFFORTS }),
    entry({ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", agent: "codex", providerId: "art-cindy", providerName: ART, efforts: EFFORTS, defaultEffort: "high" }),
    entry({ id: "openai/gpt-6.1-sol", name: "GPT-6.1 Sol", agent: "codex", providerId: "xd", providerName: XD, efforts: EFFORTS, defaultEffort: "high" }),
    entry({ id: "gpt-6-astra", name: "GPT-6 Astra", agent: "codex", providerId: "art-cindy", providerName: ART, efforts: EFFORTS, defaultEffort: "xhigh" }),
    entry({ id: "openai/gpt-6-astra", name: "GPT-6 Astra", agent: "codex", providerId: "xd", providerName: XD, efforts: EFFORTS, defaultEffort: "xhigh" }),
    entry({ id: "gpt-6-luna", name: "GPT-6 Luna", agent: "codex", providerId: "art-cindy", providerName: ART, efforts: [] }),
    // Pi is never offered.
    entry({ id: "grok-4.6", name: "Grok 4.6", agent: "pi", providerId: "art-cindy", providerName: ART, efforts: SHORT }),
    entry({ id: "x-ai-grok/grok-4.6", name: "Grok 4.6", agent: "pi", providerId: "xd", providerName: XD, efforts: SHORT }),
    // Switched off in the host: hidden everywhere.
    entry({ id: "anthropic/claude-old", name: "Old Claude", agent: "claude-code", providerId: "xd", providerName: XD, efforts: EFFORTS, visible: false }),
  ];
}

/** Dropdown value for a catalog entry, same encoding as the settings page. */
export function valueOf(agent: string, id: string, providerId: string): string {
  return JSON.stringify([agent, id, providerId]);
}
