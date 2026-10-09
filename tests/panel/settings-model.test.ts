import { describe, expect, it } from "vitest";
import { setDirectionRoute, setSlot } from "../../src/panel/manual-editor.ts";
import {
  acceptCatalogResponse,
  buildSettingsView,
  catalogArrivalAction,
  escapeHtml,
  groupModelOptions,
  renderInheritOptionHtml,
  renderProfileButtonHtml,
  renderRowHtml,
  routeAfterAgentChange,
  routeAfterEffortChange,
  routeAfterModelChange,
  SETTINGS_ACCORDION_IDS,
  SETTINGS_ROW_IDS,
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

describe("buildSettingsView", () => {
  it("renders two harness tabs with the same seven rows and three controls", () => {
    const models = appendixCAgentModels();
    for (const harness of ["codex", "claude-code"] as const) {
      const view = buildSettingsView(DEFAULT_MANUAL, { harness, taskType: "default" }, models);
      expect(view.tabs).toHaveLength(2);
      expect(view.tabs.map((t) => t.id)).toEqual(["codex", "claude-code"]);
      expect(view.statusIds).toEqual([...SETTINGS_STATUS_IDS]);
      expect(view.accordionIds).toEqual([...SETTINGS_ACCORDION_IDS]);
      expect(view.rowIds).toEqual([...SETTINGS_ROW_IDS]);
      expect(view.rows.map((r) => r.id)).toEqual([...SETTINGS_ROW_IDS]);
      expect(view.rows).toHaveLength(7);
      for (const row of view.rows) {
        expect(row.agent.label).toBe("运行环境");
        expect(row.model.label).toBe("模型");
        expect(row.effort.label).toBe("档位");
        expect(row.agent.options.map((o) => o.value)).toEqual(["codex", "claude-code", "pi"]);
      }
    }
  });

  it("does not borrow the other harness profile and shows 主控自己定 on Codex", () => {
    const models = appendixCAgentModels();
    const codex = buildSettingsView(DEFAULT_MANUAL, { harness: "codex", profileId: "grok", taskType: "default" }, models);
    expect(codex.profileId).toBe("sol");
    const dir = codex.rows.find((r) => r.id === "direction")!;
    expect(dir.directionSelf).toBe(true);
    expect(dir.agent.disabled).toBe(true);
    expect(dir.effort.disabled).toBe(true);
    expect(dir.model.options[0]).toMatchObject({ value: "", label: "主控自己定" });
    expect(dir.model.groups.length).toBeGreaterThan(0);
    expect(dir.model.groups.some((g) => g.label.startsWith("和主控持平") || g.label.startsWith("比主控强") || g.label.startsWith("未分级"))).toBe(true);
    expect(dir.model.groups.flatMap((g) => g.options).some((o) => o.value.includes("gpt-6-luna"))).toBe(false);
    expect(dir.hiddenWeaker).toBeGreaterThan(0);
    expect(dir.agent.value).toBe("codex");
    const claude = buildSettingsView(DEFAULT_MANUAL, { harness: "claude-code", taskType: "default" }, models);
    expect(claude.profileId).toBe("grok");
    expect(claude.rows.find((r) => r.id === "direction")?.directionSelf).toBe(false);
    expect(claude.rows.find((r) => r.id === "direction")?.route).toMatchObject({ model: "anthropic/claude-opus-5-5" });
    expect(claude.rows.find((r) => r.id === "verifier")?.route).toMatchObject({ agent: "codex", model: "gpt-6-luna" });
  });

  it("task view locks inherited roles and can materialize an override without dropping draft routes", () => {
    const models = appendixCAgentModels();
    const view = buildSettingsView(DEFAULT_MANUAL, { harness: "codex", taskType: "bug-fix" }, models);
    expect(view.taskScope).toBe("task");
    expect(view.rows.find((r) => r.id === "lead")?.source).toMatch(/作用于所有任务/);
    expect(view.rows.find((r) => r.id === "worker")?.locked).toBe(true);
    const owned = setSlot(DEFAULT_MANUAL, "sol", "bug-fix", "worker", {
      primary: { agent: "pi", model: "grok-4.6", provider_id: "art-cindy", effort: "high" },
    });
    const after = buildSettingsView(owned, { harness: "codex", taskType: "bug-fix" }, models);
    expect(after.rows.find((r) => r.id === "worker")?.locked).toBe(false);
    expect(after.overrideCount).toBe(1);
    expect(buildSettingsView(owned, { harness: "codex", taskType: "default" }, models).rows.find((r) => r.id === "explorer")?.route?.effort).toBe("medium");
  });
});

describe("groupModelOptions / efforts", () => {
  it("lists only visible models, grouped by providerId, and does not merge gateways", () => {
    const models: AgentModel[] = [
      model({ id: "gpt-6-luna", agent: "codex", providerId: "art-cindy", providerName: "Art Cindy", efforts: ["medium", "high"] }),
      model({ id: "gpt-6-luna", agent: "codex", providerId: "xd", providerName: "Cindy AI", efforts: ["low"] }),
      { id: "hidden", agent: "codex", providerId: "art-cindy", visible: false, efforts: ["high"] },
      { id: "no-flag", agent: "codex", providerId: "art-cindy" },
      model({ id: "gpt-6-luna", agent: "pi", providerId: "art-cindy", providerName: "Art Cindy", efforts: ["high"] }),
    ];
    expect(visibleModels(models, "codex").map((m) => `${m.id}:${m.providerId}`)).toEqual(["gpt-6-luna:art-cindy", "gpt-6-luna:xd"]);
    const groups = groupModelOptions(models, "codex");
    expect(groups.map((g) => g.providerId).sort()).toEqual(["art-cindy", "xd"]);
    const art = groups.find((g) => g.providerId === "art-cindy")!;
    const xd = groups.find((g) => g.providerId === "xd")!;
    expect(art.options).toHaveLength(1);
    expect(xd.options[0]?.value).toBe("gpt-6-luna\txd");
    expect(art.label).toBe("Art Cindy");
  });

  it("effort options come only from the selected triple; empty efforts disable the control", () => {
    const models = [
      model({ id: "gpt-6-luna", agent: "codex", providerId: "art-cindy", efforts: ["medium", "high"] }),
      model({ id: "plain", agent: "codex", providerId: "art-cindy", efforts: [] }),
    ];
    const luna = buildSettingsView(DEFAULT_MANUAL, { harness: "codex", taskType: "default" }, models);
    const explorer = luna.rows.find((r) => r.id === "explorer")!;
    expect(explorer.effort.options.filter((o) => !o.disabled).map((o) => o.value)).toEqual(["medium", "high"]);
    const next = setSlot(DEFAULT_MANUAL, "sol", "default", "explorer", { primary: { agent: "codex", model: "plain", provider_id: "art-cindy" } });
    const row = buildSettingsView(next, { harness: "codex", taskType: "default" }, models).rows.find((r) => r.id === "explorer")!;
    expect(row.effort.disabled).toBe(true);
    expect(row.effort.placeholder).toBe("不声明档位");
  });

  it("keeps a hidden current value out of selectable options", () => {
    const models: AgentModel[] = [
      { id: "gpt-6.1-sol", agent: "codex", providerId: "art-cindy", visible: false, efforts: ["high"] },
      model({ id: "gpt-6-luna", agent: "codex", providerId: "art-cindy", efforts: ["high"] }),
    ];
    const view = buildSettingsView(DEFAULT_MANUAL, { harness: "codex", taskType: "default" }, models);
    const lead = view.rows.find((r) => r.id === "lead")!;
    expect(lead.model.groups.flatMap((g) => g.options).some((o) => o.value.includes("gpt-6.1-sol"))).toBe(false);
    expect(lead.model.options.some((o) => o.disabled && o.value.includes("gpt-6.1-sol"))).toBe(true);
  });

  it("does not invent catalog models on 404/503, and seq mismatch drops stale responses", () => {
    expect(readCatalog(404, { models: [{ id: "fake" }] }).models).toEqual([]);
    expect(readCatalog(503, { models: [{ id: "fake" }] }).models).toEqual([]);
    expect(acceptCatalogResponse(2, 1)).toBe(false);
    expect(acceptCatalogResponse(2, 2)).toBe(true);
  });
});

describe("route patch helpers", () => {
  it("retains effort only when the new model still declares it", () => {
    const models = [
      model({ id: "a", agent: "codex", providerId: "art-cindy", efforts: ["high", "xhigh"], defaultEffort: "high" }),
      model({ id: "b", agent: "codex", providerId: "xd", efforts: ["low"], defaultEffort: "low" }),
    ];
    expect(routeAfterModelChange(models, "codex", "a", "art-cindy", "high").effort).toBe("high");
    expect(routeAfterModelChange(models, "codex", "b", "xd", "high").effort).toBeUndefined();
    expect(routeAfterAgentChange(models, "codex", "high").effort).toBe("high");
    expect(routeAfterEffortChange(models, { agent: "codex", model: "a", provider_id: "art-cindy", effort: "high" }, "").effort).toBeUndefined();
  });

  it("setDirectionRoute round-trips through the view", () => {
    const models = appendixCAgentModels();
    const saved = setDirectionRoute(DEFAULT_MANUAL, "sol", { agent: "codex", model: "gpt-6-astra", provider_id: "art-cindy", effort: "xhigh" });
    const row = buildSettingsView(saved, { harness: "codex", taskType: "default" }, models).rows.find((r) => r.id === "direction")!;
    expect(row.directionSelf).toBe(false);
    expect(row.route).toMatchObject({ model: "gpt-6-astra", effort: "xhigh" });
    const self = setDirectionRoute(saved, "sol", undefined);
    const again = buildSettingsView(self, { harness: "codex", taskType: "default" }, models).rows.find((r) => r.id === "direction")!;
    expect(again.directionSelf).toBe(true);
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

function rowsHtml(view: ReturnType<typeof buildSettingsView>): string {
  return view.rows.map((row) => renderRowHtml(row, view.taskType)).join("");
}

describe("catalog interaction lock", () => {
  it("defers redraw while a select is being operated and ignores programmatic focus", () => {
    expect(shouldDeferCatalogRender(true)).toBe(true);
    expect(shouldDeferCatalogRender(false)).toBe(false);
    expect(shouldRefreshCatalogOnOpen({ act: "model", programmatic: false })).toBe(true);
    expect(shouldRefreshCatalogOnOpen({ act: "effort", programmatic: false })).toBe(true);
    expect(shouldRefreshCatalogOnOpen({ act: "agent", programmatic: false })).toBe(true);
    expect(shouldRefreshCatalogOnOpen({ act: "model", programmatic: true })).toBe(false);
    expect(shouldRefreshCatalogOnOpen({ act: "save", programmatic: false })).toBe(false);
    expect(catalogArrivalAction({ seqAccepted: true, interacting: true })).toBe("defer");
    expect(catalogArrivalAction({ seqAccepted: true, interacting: false })).toBe("store-and-render");
    expect(catalogArrivalAction({ seqAccepted: true, interacting: true, render: false })).toBe("store");
    expect(catalogArrivalAction({ seqAccepted: false, interacting: false })).toBe("ignore");
  });

  it("keeps the live select through pointerdown/focus and delayed catalog, then applies after change or blur", () => {
    let interacting = false;
    let programmatic = false;
    let pending = false;
    let rendered = 0;
    let stored = 0;

    const arrive = (seqAccepted: boolean, render?: boolean) => {
      const action = catalogArrivalAction({ seqAccepted, interacting, render });
      if (action === "ignore") return action;
      if (action === "defer") {
        pending = true;
        return action;
      }
      stored += 1;
      pending = false;
      if (action === "store-and-render") rendered += 1;
      return action;
    };

    expect(shouldRefreshCatalogOnOpen({ act: "model", programmatic })).toBe(true);
    interacting = true;
    expect(arrive(true)).toBe("defer");
    expect(rendered).toBe(0);
    expect(pending).toBe(true);

    programmatic = true;
    expect(shouldRefreshCatalogOnOpen({ act: "model", programmatic })).toBe(false);
    programmatic = false;

    expect(arrive(false)).toBe("ignore");
    expect(pending).toBe(true);

    interacting = false;
    if (pending) {
      pending = false;
      rendered += 1;
    }
    expect(rendered).toBe(1);

    interacting = true;
    expect(arrive(true, false)).toBe("store");
    expect(rendered).toBe(1);
    expect(stored).toBe(1);
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
    const saved = await saveManual(fakeIo(models), parsed.manual, models);
    expect(saved).toMatchObject({ ok: true });
    const view = buildSettingsView(parsed.manual, { harness: "codex", taskType: "default" }, models);
    const html = rowsHtml(view);
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain(XSS_ESCAPED);
    expect(html).toContain(`继承自 ${escapeHtml(parentId)}`);
    expect(view.rows.filter((r) => r.source?.includes(parentId))).toHaveLength(5);

    const chips = renderProfileButtonHtml({ id: childId, name: childName, selected: true, defaultOf: "codex" });
    expect(chips).not.toMatch(/<img/i);
    expect(chips).toContain(`data-id="${escapeHtml(childId)}"`);
    expect(chips).toContain(escapeHtml(childName));
    expect(renderInheritOptionHtml({ id: parentId, name: parentName }, parentId)).toContain(escapeHtml(parentName));

    const fbJson = JSON.stringify({
      version: 1,
      profiles: [
        {
          ...sol,
          nodes: {
            default: {
              ...sol.nodes.default,
              explorer: {
                primary: sol.nodes.default!.explorer!.primary,
                fallbacks: [{ agent: "codex", model: XSS, provider_id: XSS }],
              },
            },
          },
        },
        grok,
      ],
      defaults_by_harness: base.defaults_by_harness,
    });
    const fbParsed = parseImportedJson(fbJson);
    expect(fbParsed.ok).toBe(true);
    if (!fbParsed.ok) return;
    const fbModels = [
      ...models,
      model({ id: XSS, agent: "codex", providerId: XSS, name: XSS, providerName: XSS, efforts: ["high"] }),
    ];
    expect(await saveManual(fakeIo(fbModels), fbParsed.manual, fbModels)).toMatchObject({ ok: true });
    const fbHtml = rowsHtml(buildSettingsView(fbParsed.manual, { harness: "codex", taskType: "default" }, fbModels));
    expect(fbHtml).not.toMatch(/<img/i);
    expect(fbHtml).toContain(`备用：Codex · ${XSS_ESCAPED} · ${XSS_ESCAPED}`);

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
    const leadHtml = rowsHtml(leadView);
    expect(leadHtml).not.toMatch(/<img/i);
    expect(leadHtml).toContain(`只列比主控（${XSS_ESCAPED}）强或持平的模型`);
    expect(leadHtml).toContain(escapeHtml(amp));
    expect(leadHtml).toContain("&amp;");
    expect(leadHtml).toContain("&quot;");
  });
});
