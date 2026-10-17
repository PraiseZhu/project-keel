import { describe, expect, it } from "vitest";
import { applyGroupPrimary, applyRolePrimary, familyConflictNote, MIXED_LABEL } from "../../src/panel/grouped-models.ts";
import { setFinalReviewRoute, setSlot } from "../../src/panel/manual-editor.ts";
import {
  acceptCatalogResponse,
  buildSettingsView,
  catalogArrivalAction,
  escapeHtml,
  groupModelOptions,
  renderGroupHtml,
  renderGroupsHtml,
  renderInheritOptionHtml,
  renderLeadHtml,
  renderProfileButtonHtml,
  routeAfterAgentChange,
  routeAfterEffortChange,
  routeAfterModelChange,
  routeAfterUnifiedChange,
  SETTINGS_ACCORDION_IDS,
  SETTINGS_STATUS_IDS,
  shouldDeferCatalogRender,
  shouldRefreshCatalogOnOpen,
  visibleModels,
} from "../../src/panel/settings-model.ts";
import { cloneManual, DEFAULT_MANUAL, type AgentModel } from "../../src/shared/manual/schema.ts";
import { appendixCAgentModels } from "../manual/model-manual.test.ts";
import { parseImportedJson, readCatalog, saveManual, type SettingsIO } from "../../src/panel/manual-editor.ts";

function model(partial: AgentModel): AgentModel {
  return { name: partial.id, visible: true, ...partial };
}

function groupsHtml(view: ReturnType<typeof buildSettingsView>): string {
  return renderGroupsHtml(view.groups, view.taskType);
}

describe("buildSettingsView groups", () => {
  it("renders four groups, keeps Jev/lanes/scope accordions, and does not copy pstack 17 roles", () => {
    const models = appendixCAgentModels();
    const view = buildSettingsView(DEFAULT_MANUAL, { harness: "codex", taskType: "default" }, models);
    expect(view.tabs.map((t) => t.id)).toEqual(["codex", "claude-code"]);
    expect(view.statusIds).toEqual([...SETTINGS_STATUS_IDS]);
    expect(view.accordionIds).toEqual([...SETTINGS_ACCORDION_IDS]);
    expect(view.groups.map((g) => g.id)).toEqual(["research", "plan", "code", "review"]);
    expect(view.groups.map((g) => g.name)).toEqual(["查资料", "想方案", "写代码", "做检查"]);
    expect(view.scopeLabel).toMatch(/Sol 主控/);
    expect(view.scopeLabel).toMatch(/Codex/);
    expect(view.sessionNote).toMatch(/不会改变当前主会话模型/);
    expect(view.lead?.id).toBe("lead");
    expect(view.lead?.description).toMatch(/不是当前主会话/);
    expect(view.groups.flatMap((g) => g.fineTune.map((r) => r.id))).toEqual([
      "explorer", "researcher", "architect", "direction", "worker", "final-review", "verifier",
    ]);
    const html = groupsHtml(view);
    expect(html).toContain("查资料");
    expect(html).toContain(MIXED_LABEL);
    expect(html).not.toContain("data-row=\"lead\"");
    expect(renderLeadHtml(view.lead!)).toContain('data-row="lead"');
  });

  it("shows 按角色分别设置 when 查资料 roles differ, and unifies after a group write", () => {
    const models = appendixCAgentModels();
    const view = buildSettingsView(DEFAULT_MANUAL, { harness: "codex", taskType: "default" }, models);
    expect(view.groups.find((g) => g.id === "research")?.mixed).toBe(true);
    expect(view.groups.find((g) => g.id === "research")?.primary?.route).toBeUndefined();
    const unified = applyGroupPrimary(DEFAULT_MANUAL, "sol", "default", "research", {
      agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy", effort: "high",
    });
    const after = buildSettingsView(unified, { harness: "codex", taskType: "default" }, models);
    const research = after.groups.find((g) => g.id === "research")!;
    expect(research.mixed).toBe(false);
    expect(research.primary?.route).toMatchObject({ model: "gpt-6-luna", effort: "high" });
  });

  it("renders a unify select for mixed groups even if primary is missing", () => {
    const models = appendixCAgentModels();
    const view = buildSettingsView(DEFAULT_MANUAL, { harness: "codex", taskType: "default" }, models);
    const research = view.groups.find((g) => g.id === "research")!;
    expect(research.mixed).toBe(true);
    const html = renderGroupHtml(research, "default");
    expect(html).toContain(MIXED_LABEL);
    expect(html).toContain('data-row="research"');
    expect(html).toContain('data-act="model"');
    const { primary: _drop, ...rest } = research;
    const without = renderGroupHtml(rest, "default");
    expect(without).toContain(MIXED_LABEL);
    expect(without).toContain('data-act="model"');
  });

  it("keeps 写代码 single-model and 做检查 同方案, with verifier only in fine-tune", () => {
    const models = appendixCAgentModels();
    const view = buildSettingsView(DEFAULT_MANUAL, { harness: "codex", taskType: "default" }, models);
    const code = view.groups.find((g) => g.id === "code")!;
    expect(code.allowCollaborators).toBe(false);
    expect(code.canAddCollaborator).toBe(false);
    expect(code.primary?.route?.model).toBe("grok-4.6");
    const review = view.groups.find((g) => g.id === "review")!;
    expect(review.sameAsArchitect).toBe(true);
    expect(review.fineTune.map((r) => r.id)).toEqual(["final-review", "verifier"]);
    expect(review.fineTune.find((r) => r.id === "verifier")?.description).toMatch(/旧验证/);
    expect(groupsHtml(view)).toContain("旧验证角色");
  });

  it("family hint uses actual final-review, not the retired verifier", () => {
    const models = appendixCAgentModels();
    expect(familyConflictNote(DEFAULT_MANUAL, "sol", "default")).toBeUndefined();
    const same = setFinalReviewRoute(DEFAULT_MANUAL, "sol", {
      agent: "pi", model: "grok-4.6", provider_id: "art-cindy", effort: "high",
    });
    const note = familyConflictNote(same, "sol", "default");
    expect(note).toMatch(/终审与写手不能同模型族/);
    expect(note).toMatch(/grok-4.6/);
    expect(note).toMatch(/旧验证角色不参与/);
    const view = buildSettingsView(same, { harness: "codex", taskType: "default" }, models);
    expect(view.groups.find((g) => g.id === "review")?.familyNote).toMatch(/终审与写手/);
  });
});

describe("groupModelOptions / efforts / undeclared visible", () => {
  it("lists visible and undeclared models, grouped by providerId, and does not merge gateways", () => {
    const models: AgentModel[] = [
      model({ id: "gpt-6-luna", agent: "codex", providerId: "art-cindy", providerName: "Art Cindy", efforts: ["medium", "high"] }),
      model({ id: "gpt-6-luna", agent: "codex", providerId: "xd", providerName: "Cindy AI", efforts: ["low"] }),
      { id: "hidden", agent: "codex", providerId: "art-cindy", visible: false, efforts: ["high"] },
      { id: "no-flag", agent: "codex", providerId: "art-cindy" },
      model({ id: "gpt-6-luna", agent: "pi", providerId: "art-cindy", providerName: "Art Cindy", efforts: ["high"] }),
    ];
    expect(visibleModels(models, "codex").map((m) => `${m.id}:${m.providerId}`)).toEqual([
      "gpt-6-luna:art-cindy", "gpt-6-luna:xd", "no-flag:art-cindy",
    ]);
    const groups = groupModelOptions(models, "codex");
    expect(groups.map((g) => g.providerId).sort()).toEqual(["art-cindy", "xd"]);
  });

  it("keeps a hidden current value out of selectable options and marks it stale", () => {
    const models: AgentModel[] = [
      { id: "gpt-6.1-sol", agent: "codex", providerId: "art-cindy", visible: false, efforts: ["high"] },
      model({ id: "gpt-6-luna", agent: "codex", providerId: "art-cindy", efforts: ["high"] }),
    ];
    const view = buildSettingsView(DEFAULT_MANUAL, { harness: "codex", taskType: "default" }, models);
    const lead = view.lead!;
    expect(lead.model.groups.flatMap((g) => g.options).some((o) => o.value.includes("gpt-6.1-sol"))).toBe(false);
    expect(lead.model.options.some((o) => o.disabled && o.value.includes("gpt-6.1-sol"))).toBe(true);
    expect(lead.stale).toBeTruthy();
  });

  it("does not invent catalog models on 404/503, and seq mismatch drops stale responses", () => {
    expect(readCatalog(404, { models: [{ id: "fake" }] }).models).toEqual([]);
    expect(readCatalog(503, { models: [{ id: "fake" }] }).models).toEqual([]);
    expect(acceptCatalogResponse(2, 1)).toBe(false);
    expect(acceptCatalogResponse(2, 2)).toBe(true);
  });
});

describe("route patch helpers", () => {
  it("retains effort only when the new model still declares it, and never swaps provider", () => {
    const models = [
      model({ id: "a", agent: "codex", providerId: "art-cindy", efforts: ["high", "xhigh"], defaultEffort: "high" }),
      model({ id: "b", agent: "codex", providerId: "xd", efforts: ["low"], defaultEffort: "low" }),
    ];
    expect(routeAfterModelChange(models, "codex", "a", "art-cindy", "high").effort).toBe("high");
    expect(routeAfterModelChange(models, "codex", "b", "xd", "high").effort).toBeUndefined();
    expect(routeAfterUnifiedChange(models, "codex\tb\txd", "high")).toEqual({ agent: "codex", model: "b", provider_id: "xd" });
    expect(routeAfterAgentChange(models, "codex", "high").effort).toBe("high");
    expect(routeAfterEffortChange(models, { agent: "codex", model: "a", provider_id: "art-cindy", effort: "high" }, "").effort).toBeUndefined();
  });
});

const XSS = "<img src=x onerror=alert(1)>";
const XSS_ESCAPED = "&lt;img src=x onerror=alert(1)&gt;";

function fakeIo(models: readonly AgentModel[]): SettingsIO {
  const kv: Record<string, unknown> = {};
  return {
    async getKv() { return { ...kv }; },
    async putKv(next) {
      for (const k of Object.keys(kv)) delete kv[k];
      Object.assign(kv, next);
      return { ok: true, status: 204 };
    },
    async getAgentModels() { return { status: 200, body: { ok: true, models } }; },
    broadcast() {},
  };
}

describe("catalog interaction lock", () => {
  it("defers redraw while a select is being operated and ignores programmatic focus", () => {
    expect(shouldDeferCatalogRender(true)).toBe(true);
    expect(shouldRefreshCatalogOnOpen({ act: "model", programmatic: false })).toBe(true);
    expect(shouldRefreshCatalogOnOpen({ act: "effort", programmatic: false })).toBe(true);
    expect(shouldRefreshCatalogOnOpen({ act: "collab-model", programmatic: false })).toBe(true);
    expect(shouldRefreshCatalogOnOpen({ act: "fb-model", programmatic: false })).toBe(true);
    expect(shouldRefreshCatalogOnOpen({ act: "model", programmatic: true })).toBe(false);
    expect(shouldRefreshCatalogOnOpen({ act: "save", programmatic: false })).toBe(false);
    expect(catalogArrivalAction({ seqAccepted: true, interacting: true })).toBe("defer");
    expect(catalogArrivalAction({ seqAccepted: true, interacting: false })).toBe("store-and-render");
    expect(catalogArrivalAction({ seqAccepted: false, interacting: false })).toBe("ignore");
  });
});

describe("settings HTML escaping", () => {
  it("escapes inherit id/name, fallback model/provider, lead.model, and catalog labels", async () => {
    const amp = "a&b\"c<";
    const parentId = `base${XSS}`;
    const childId = `child${XSS}`;
    const parentName = `父${XSS}`;
    const childName = `子${XSS}`;
    const base = cloneManual(DEFAULT_MANUAL);
    const sol = base.profiles[0]!;
    const grok = base.profiles[1]!;
    const inheritJson = JSON.stringify({
      version: 1,
      profiles: [
        { ...sol, id: childId, name: childName, inherit: parentId, nodes: {} },
        { ...sol, id: parentId, name: parentName },
        grok,
      ],
      defaults_by_harness: { ...base.defaults_by_harness, codex: childId },
    });
    const parsed = parseImportedJson(inheritJson);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const models = appendixCAgentModels();
    expect(await saveManual(fakeIo(models), parsed.manual, models)).toMatchObject({ ok: true });
    const view = buildSettingsView(parsed.manual, { harness: "codex", taskType: "default" }, models);
    const html = groupsHtml(view);
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain(XSS_ESCAPED);
    expect(view.groups.flatMap((g) => g.fineTune).some((r) => r.source?.includes(parentId))).toBe(true);

    const chips = renderProfileButtonHtml({ id: childId, name: childName, selected: true, defaultOf: "codex" });
    expect(chips).not.toMatch(/<img/i);
    expect(chips).toContain(`data-id="${escapeHtml(childId)}"`);
    expect(renderInheritOptionHtml({ id: parentId, name: parentName }, parentId)).toContain(escapeHtml(parentName));

    const leadJson = JSON.stringify({
      version: 1,
      profiles: [{ ...sol, lead: { ...sol.lead, model: XSS } }, grok],
      defaults_by_harness: base.defaults_by_harness,
    });
    const leadParsed = parseImportedJson(leadJson);
    expect(leadParsed.ok).toBe(true);
    if (!leadParsed.ok) return;
    const leadModels = [
      ...models,
      model({ id: XSS, agent: "codex", providerId: sol.lead.provider_id, name: XSS, providerName: amp, efforts: ["high"] }),
    ];
    expect(await saveManual(fakeIo(leadModels), leadParsed.manual, leadModels)).toMatchObject({ ok: true });
    const leadView = buildSettingsView(leadParsed.manual, { harness: "codex", taskType: "default" }, leadModels);
    const leadHtml = renderLeadHtml(leadView.lead!);
    expect(leadHtml).not.toMatch(/<img/i);
    expect(leadHtml).toContain(XSS_ESCAPED);
    expect(leadHtml).toContain(escapeHtml(amp));
  });
});

describe("fallback rows in role fine-tune", () => {
  const models = appendixCAgentModels();

  it("shows fallbacks on slot roles, not on lead/final-review/direction", () => {
    const view = buildSettingsView(DEFAULT_MANUAL, { harness: "codex", taskType: "default" }, models);
    const byId = Object.fromEntries(view.groups.flatMap((g) => g.fineTune.map((r) => [r.id, r])));
    for (const id of ["worker", "architect", "explorer", "researcher"] as const) {
      expect(byId[id]?.fallbacks?.items.length).toBeGreaterThanOrEqual(0);
    }
    expect(byId["final-review"]?.fallbacks).toBeUndefined();
    expect(byId.direction?.fallbacks).toBeUndefined();
    expect(view.lead?.fallbacks).toBeUndefined();
  });

  it("keeps inherited fallbacks read-only on locked task-type rows", () => {
    const view = buildSettingsView(DEFAULT_MANUAL, { harness: "codex", taskType: "bug-fix" }, models);
    const worker = view.groups.find((g) => g.id === "code")!.fineTune.find((r) => r.id === "worker")!;
    expect(worker.locked).toBe(true);
    expect(worker.fallbacks?.disabled).toBe(true);
  });
});

describe("role split after group unify", () => {
  it("does not report the first role as representing the group once they diverge", () => {
    const models = appendixCAgentModels();
    const unified = applyGroupPrimary(DEFAULT_MANUAL, "sol", "default", "research", {
      agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy", effort: "high",
    });
    const split = applyRolePrimary(unified, "sol", "default", "researcher", {
      agent: "codex", model: "gpt-6-astra", provider_id: "art-cindy", effort: "xhigh",
    });
    const view = buildSettingsView(split, { harness: "codex", taskType: "default" }, models);
    const research = view.groups.find((g) => g.id === "research")!;
    expect(research.mixed).toBe(true);
    expect(groupsHtml(view)).toContain(MIXED_LABEL);
    expect(research.fineTune.find((r) => r.id === "explorer")?.route?.model).toBe("gpt-6-luna");
    expect(research.fineTune.find((r) => r.id === "researcher")?.route?.model).toBe("gpt-6-astra");
  });
});
