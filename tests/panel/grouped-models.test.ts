import { describe, expect, it } from "vitest";
import {
  addGroupCollaborator,
  applyGroupCollaborators,
  applyGroupPrimary,
  applyRoleCollaborators,
  applyRolePrimary,
  canAddCollaborator,
  familyConflictNote,
  GROUPS,
  MIXED_LABEL,
  nativeSubBlockedNote,
  NATIVE_SUB_BLOCK,
  readGroupState,
  routeKey,
  VERIFIER_NOTE,
} from "../../src/panel/grouped-models.ts";
import { fingerprintManual, saveManual, setSlot, withSavedVersion, type SettingsIO } from "../../src/panel/manual-editor.ts";
import { resolveFinalReview } from "../../src/shared/manual/resolve.ts";
import { cloneManual, DEFAULT_MANUAL, MANUAL_VERSION, MAX_COLLABORATORS, type AgentModel, type Route } from "../../src/shared/manual/schema.ts";
import { appendixCAgentModels } from "../manual/model-manual.test.ts";

const luna: Route = { agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy", effort: "high" };
const astra: Route = { agent: "codex", model: "gpt-6-astra", provider_id: "art-cindy", effort: "xhigh" };
const grok: Route = { agent: "pi", model: "grok-4.6", provider_id: "art-cindy", effort: "high" };

function fakeIo(kv: Record<string, unknown> = {}): SettingsIO & { kv: Record<string, unknown> } {
  return {
    kv,
    async getKv() { return { ...kv }; },
    async putKv(next) {
      for (const k of Object.keys(kv)) delete kv[k];
      Object.assign(kv, next);
      return { ok: true, status: 204 };
    },
    async getAgentModels() { return { status: 200, body: { models: appendixCAgentModels() } }; },
    broadcast() {},
  };
}

describe("group mapping", () => {
  it("uses four Keel groups and keeps verifier only in 做检查 fine-tune", () => {
    expect(GROUPS.map((g) => g.name)).toEqual(["查资料", "想方案", "写代码", "做检查"]);
    expect(GROUPS.find((g) => g.id === "research")?.allowCollaborators).toBe(true);
    expect(GROUPS.find((g) => g.id === "plan")?.allowCollaborators).toBe(true);
    expect(GROUPS.find((g) => g.id === "code")?.allowCollaborators).toBe(false);
    expect(GROUPS.find((g) => g.id === "review")?.allowCollaborators).toBe(true);
    expect(GROUPS.find((g) => g.id === "review")?.fineTune).toEqual(["final-review", "verifier"]);
    expect(GROUPS.find((g) => g.id === "review")?.targets).toEqual([{ kind: "final-review" }]);
    expect(VERIFIER_NOTE).toMatch(/旧验证/);
    expect(MIXED_LABEL).toBe("按角色分别设置");
    expect(GROUPS.flatMap((g) => g.fineTune)).not.toContain("lead");
  });
});

describe("mixed vs unified", () => {
  it("marks 查资料 mixed when explorer and researcher differ, and does not pretend the first represents both", () => {
    const state = readGroupState(DEFAULT_MANUAL, "sol", "default", "research");
    expect(state.mixed).toBe(true);
    expect(state.primary).toBeUndefined();
    expect(state.collaborators).toEqual([]);
    const explorer = state.targets[0]?.primary;
    const researcher = state.targets[1]?.primary;
    expect(explorer?.effort).toBe("medium");
    expect(researcher?.effort).toBe("high");
    expect(routeKey(explorer!)).not.toBe(routeKey(researcher!));
  });

  it("marks 想方案 mixed when direction is 主控自己定 and architect is explicit", () => {
    const state = readGroupState(DEFAULT_MANUAL, "sol", "default", "plan");
    expect(state.mixed).toBe(true);
    expect(state.targets.some((t) => t.directionSelf)).toBe(true);
    expect(state.targets.some((t) => t.primary?.model === "gpt-6-astra")).toBe(true);
  });

  it("keeps 写代码 unified on the worker primary and 做检查 as 同方案", () => {
    const code = readGroupState(DEFAULT_MANUAL, "sol", "default", "code");
    expect(code.mixed).toBe(false);
    expect(code.primary).toMatchObject({ model: "grok-4.6", agent: "pi" });
    const review = readGroupState(DEFAULT_MANUAL, "sol", "default", "review");
    expect(review.mixed).toBe(false);
    expect(review.sameAsArchitect).toBe(true);
    expect(review.primary).toMatchObject({ model: "gpt-6-astra", effort: "xhigh" });
  });
});

describe("group writes", () => {
  it("writes 查资料 to explorer and researcher slots; keeps fallbacks only when primary identity+effort stay", () => {
    const sameResearcher = applyGroupPrimary(DEFAULT_MANUAL, "sol", "default", "research", luna);
    const nodes = sameResearcher.profiles[0]!.nodes.default!;
    expect(nodes.explorer?.primary).toEqual(luna);
    expect(nodes.researcher?.primary).toEqual(luna);
    expect(nodes.explorer?.fallbacks).toBeUndefined();
    expect(nodes.researcher?.fallbacks).toEqual(DEFAULT_MANUAL.profiles[0]!.nodes.default!.researcher!.fallbacks);
    expect(readGroupState(sameResearcher, "sol", "default", "research").mixed).toBe(false);
    expect(nodes.worker?.primary.model).toBe("grok-4.6");
    const again = applyGroupPrimary(sameResearcher, "sol", "default", "research", luna);
    expect(again.profiles[0]!.nodes.default!.researcher?.fallbacks).toEqual(nodes.researcher?.fallbacks);
  });

  it("writes 想方案 to architect and direction_route, not a new config root", () => {
    const next = applyGroupPrimary(DEFAULT_MANUAL, "sol", "default", "plan", astra);
    const sol = next.profiles[0]!;
    expect(sol.nodes.default!.architect?.primary).toEqual(astra);
    expect(sol.direction_gate).toBe("astra");
    expect(sol.direction_route).toEqual(astra);
    expect(sol.nodes.default!.architect?.fallbacks).toEqual(DEFAULT_MANUAL.profiles[0]!.nodes.default!.architect!.fallbacks);
  });

  it("writes 做检查 to final_review_route and leaves verifier for fine-tune", () => {
    const next = applyGroupPrimary(DEFAULT_MANUAL, "sol", "default", "review", astra);
    expect(next.profiles[0]!.final_review_route).toEqual(astra);
    expect(next.profiles[0]!.nodes.default!.verifier?.primary.model).toBe("gpt-6-luna");
  });

  it("stores true collaborators, not fallbacks, and caps at primary+3", () => {
    const unified = applyGroupPrimary(DEFAULT_MANUAL, "sol", "default", "research", luna);
    const collabs: Route[] = [
      { agent: "codex", model: "gpt-6-astra", provider_id: "art-cindy", effort: "xhigh" },
      { agent: "claude-code", model: "anthropic/claude-opus-5-5", provider_id: "xd", effort: "xhigh" },
      { agent: "codex", model: "openai/gpt-6-luna", provider_id: "xd", effort: "high" },
    ];
    const withCollab = applyGroupCollaborators(unified, "sol", "default", "research", collabs);
    const explorer = withCollab.profiles[0]!.nodes.default!.explorer!;
    expect(explorer.collaborators).toEqual(collabs);
    expect(explorer.fallbacks).toBeUndefined();
    expect(explorer.collaborators?.[0]?.model).not.toBe(explorer.fallbacks?.[0]?.model);
    const extra = applyGroupCollaborators(withCollab, "sol", "default", "research", [...collabs, grok]);
    expect(extra.profiles[0]!.nodes.default!.explorer!.collaborators).toHaveLength(MAX_COLLABORATORS);
    expect(canAddCollaborator(true, false, MAX_COLLABORATORS)).toBe(false);
    const added = addGroupCollaborator(withCollab, "sol", "default", "research");
    expect(added.profiles[0]!.nodes.default!.explorer!.collaborators).toHaveLength(MAX_COLLABORATORS);
  });

  it("does not delete task-type overrides when writing the default column", () => {
    const owned = setSlot(DEFAULT_MANUAL, "sol", "bug-fix", "worker", {
      primary: { agent: "pi", model: "grok-4.6", provider_id: "art-cindy", effort: "medium" },
    });
    const next = applyGroupPrimary(owned, "sol", "default", "code", grok);
    expect(next.profiles[0]!.nodes["bug-fix"]?.worker?.primary.effort).toBe("medium");
    expect(next.profiles[0]!.nodes.default!.worker?.primary).toEqual(grok);
  });

  it("does not write worker collaborators", () => {
    const next = applyGroupCollaborators(DEFAULT_MANUAL, "sol", "default", "code", [luna]);
    expect(next.profiles[0]!.nodes.default!.worker?.collaborators).toBeUndefined();
    const viaRole = applyRoleCollaborators(DEFAULT_MANUAL, "sol", "default", "worker", [luna]);
    expect(viaRole.profiles[0]!.nodes.default!.worker?.collaborators).toBeUndefined();
  });
});

describe("catalog triple and version", () => {
  it("keeps the selected provider and effort when the new model still declares them", () => {
    const next = applyGroupPrimary(DEFAULT_MANUAL, "sol", "default", "code", {
      agent: "pi",
      model: "x-ai-grok/grok-4.6",
      provider_id: "xd",
      effort: "high",
    });
    expect(next.profiles[0]!.nodes.default!.worker?.primary).toEqual({
      agent: "pi",
      model: "x-ai-grok/grok-4.6",
      provider_id: "xd",
      effort: "high",
    });
  });

  it("bumps version only on save, not on read", async () => {
    const loaded = cloneManual(DEFAULT_MANUAL);
    expect(loaded.version).toBe(1);
    expect(withSavedVersion(loaded).version).toBe(MANUAL_VERSION);
    expect(loaded.version).toBe(1);
    const io = fakeIo({ extra: 1, manual: loaded });
    const models: AgentModel[] = appendixCAgentModels();
    const result = await saveManual(io, loaded, models, { expectedFingerprint: fingerprintManual(loaded) });
    expect(result).toEqual({ ok: true });
    expect((io.kv.manual as { version: number }).version).toBe(2);
    expect(io.kv.extra).toBe(1);
    expect(fingerprintManual(loaded)).toBe(fingerprintManual(DEFAULT_MANUAL));
  });

  it("refuses a concurrent save when stored manual changed, without Host CAS", async () => {
    const loaded = cloneManual(DEFAULT_MANUAL);
    const io = fakeIo({ manual: loaded, keep: true });
    const other = applyGroupPrimary(loaded, "sol", "default", "code", luna);
    io.kv.manual = other;
    const result = await saveManual(io, applyRolePrimary(loaded, "sol", "default", "worker", grok), appendixCAgentModels(), {
      expectedFingerprint: fingerprintManual(loaded),
    });
    expect(result).toMatchObject({ ok: false, kind: "conflict" });
    expect((result as { message: string }).message).toMatch(/未使用 Host 原子 CAS/);
    expect(io.kv.keep).toBe(true);
    expect(io.kv.manual).toEqual(other);
  });
});

describe("role fine-tune", () => {
  it("lets one role diverge so the group reports mixed instead of copying the first", () => {
    const unified = applyGroupPrimary(DEFAULT_MANUAL, "sol", "default", "research", luna);
    const split = applyRolePrimary(unified, "sol", "default", "researcher", astra);
    const state = readGroupState(split, "sol", "default", "research");
    expect(state.mixed).toBe(true);
    expect(state.primary).toBeUndefined();
    expect(split.profiles[0]!.nodes.default!.explorer?.primary).toEqual(luna);
    expect(split.profiles[0]!.nodes.default!.researcher?.primary).toEqual(astra);
  });

  it("does not treat fallbacks as collaboration", () => {
    const withFb = setSlot(DEFAULT_MANUAL, "sol", "default", "explorer", {
      primary: luna,
      fallbacks: [astra],
      collaborators: [grok],
    });
    const read = readGroupState(withFb, "sol", "default", "research");
    expect(read.mixed).toBe(true);
    expect(withFb.profiles[0]!.nodes.default!.explorer?.fallbacks?.[0]).toEqual(astra);
    expect(withFb.profiles[0]!.nodes.default!.explorer?.collaborators?.[0]).toEqual(grok);
  });

  it("bumps version to 2 when writing collaborators", () => {
    const unified = applyGroupPrimary(DEFAULT_MANUAL, "sol", "default", "research", luna);
    expect(unified.version).toBe(1);
    const withCollab = applyGroupCollaborators(unified, "sol", "default", "research", [astra]);
    expect(withCollab.version).toBe(2);
  });

  it("shows inherited final-review as architect primary+collaborators and materializes without touching architect", () => {
    const architect = DEFAULT_MANUAL.profiles[0]!.nodes.default!.architect!;
    const withArch = setSlot(DEFAULT_MANUAL, "sol", "default", "architect", {
      primary: architect.primary,
      fallbacks: architect.fallbacks,
      collaborators: [luna],
    });
    const resolved = resolveFinalReview(withArch, "sol", "default");
    expect(resolved.primary).toEqual(architect.primary);
    expect(resolved.collaborators).toEqual([luna]);
    const state = readGroupState(withArch, "sol", "default", "review");
    expect(state.sameAsArchitect).toBe(true);
    expect(state.primary).toEqual(architect.primary);
    expect(state.collaborators).toEqual([luna]);
    const saved = applyGroupCollaborators(withArch, "sol", "default", "review", [luna, grok]);
    const sol = saved.profiles[0]!;
    expect(sol.nodes.default!.architect?.collaborators).toEqual([luna]);
    expect(sol.nodes.default!.architect?.primary).toEqual(architect.primary);
    expect(sol.final_review_route).toEqual(architect.primary);
    expect(sol.final_review_collaborators).toEqual([luna, grok]);
    expect(resolveFinalReview(saved, "sol", "default")).toMatchObject({
      primary: architect.primary,
      collaborators: [luna, grok],
    });
    const viaRole = applyRoleCollaborators(withArch, "sol", "default", "final-review", [grok]);
    expect(viaRole.profiles[0]!.nodes.default!.architect?.collaborators).toEqual([luna]);
    expect(viaRole.profiles[0]!.final_review_route).toEqual(architect.primary);
    expect(viaRole.profiles[0]!.final_review_collaborators).toEqual([grok]);
  });

  it("does not store collaborators without a primary route", () => {
    const orphan = applyRoleCollaborators(DEFAULT_MANUAL, "sol", "default", "direction", [astra]);
    expect(orphan.profiles[0]!.direction_route).toBeUndefined();
    expect(orphan.profiles[0]!.direction_collaborators).toBeUndefined();
    const withRoute = applyRolePrimary(DEFAULT_MANUAL, "sol", "default", "direction", astra);
    const withBoth = applyRoleCollaborators(withRoute, "sol", "default", "direction", [luna]);
    expect(withBoth.profiles[0]!.direction_route).toEqual(astra);
    expect(withBoth.profiles[0]!.direction_collaborators).toEqual([luna]);
  });

  it("flags cross-harness native sub as not executable", () => {
    expect(nativeSubBlockedNote("codex", [luna])).toBeUndefined();
    expect(nativeSubBlockedNote("codex", [grok])).toMatch(NATIVE_SUB_BLOCK);
    expect(familyConflictNote(DEFAULT_MANUAL, "sol", "default")).toBeUndefined();
  });
});
