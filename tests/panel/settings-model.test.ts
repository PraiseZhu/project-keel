import { describe, expect, it } from "vitest";
import { setDirectionRoute, setFinalReviewRoute, setSlot } from "../../src/panel/manual-editor.ts";
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
import { cloneManual, DEFAULT_MANUAL, ROLES, type AgentModel } from "../../src/shared/manual/schema.ts";
import { appendixCAgentModels } from "../manual/model-manual.test.ts";
import { parseImportedJson, readCatalog, saveManual, type SettingsIO } from "../../src/panel/manual-editor.ts";

function model(partial: AgentModel): AgentModel {
  return { name: partial.id, visible: true, ...partial };
}

describe("buildSettingsView", () => {
  it("renders two harness tabs with the same eight rows and three controls", () => {
    const models = appendixCAgentModels();
    for (const harness of ["codex", "claude-code"] as const) {
      const view = buildSettingsView(DEFAULT_MANUAL, { harness, taskType: "default" }, models);
      expect(view.tabs).toHaveLength(2);
      expect(view.tabs.map((t) => t.id)).toEqual(["codex", "claude-code"]);
      expect(view.statusIds).toEqual([...SETTINGS_STATUS_IDS]);
      expect(view.accordionIds).toEqual([...SETTINGS_ACCORDION_IDS]);
      expect(view.rowIds).toEqual([...SETTINGS_ROW_IDS]);
      expect(view.rows.map((r) => r.id)).toEqual([...SETTINGS_ROW_IDS]);
      expect(view.rows).toHaveLength(8);
      expect(view.rows.find((r) => r.id === "architect")?.label).toBe("方案");
      expect(view.rows.find((r) => r.id === "final-review")?.label).toBe("终审");
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
    const fr = view.rows.find((r) => r.id === "final-review")!;
    expect(fr.profileLevel).toBe(true);
    expect(fr.locked).toBe(false);
    expect(fr.source).toMatch(/作用于所有任务/);
    expect(rowsHtml(view)).not.toMatch(/data-act="own" data-row="final-review"/);
    expect(rowsHtml(view)).not.toMatch(/data-act="inherit-slot" data-row="final-review"/);
  });

  it("final-review is 同方案 on Codex and explicit Astra on Claude, listing all visible models", () => {
    const models = appendixCAgentModels();
    const codex = buildSettingsView(DEFAULT_MANUAL, { harness: "codex", taskType: "default" }, models);
    const fr = codex.rows.find((r) => r.id === "final-review")!;
    expect(fr.model.options[0]).toMatchObject({ value: "", label: "同方案" });
    expect(fr.model.value).toBe("");
    expect(fr.agent.disabled).toBe(false);
    expect(fr.effort.disabled).toBe(true);
    expect(fr.source).toMatch(/同方案/);
    expect(fr.model.groups.flatMap((g) => g.options).some((o) => o.value.includes("gpt-6-luna"))).toBe(true);
    const switched = setFinalReviewRoute(DEFAULT_MANUAL, "sol", { agent: "claude-code", model: "anthropic/claude-opus-5-5", provider_id: "xd", effort: "xhigh" });
    const after = buildSettingsView(switched, { harness: "codex", taskType: "default" }, models).rows.find((r) => r.id === "final-review")!;
    expect(after.agent.value).toBe("claude-code");
    expect(after.model.value).toBe("anthropic/claude-opus-5-5\txd");
    expect(after.effort.disabled).toBe(false);
    expect(after.effort.value).toBe("xhigh");

    const claude = buildSettingsView(DEFAULT_MANUAL, { harness: "claude-code", taskType: "default" }, models);
    expect(claude.rows.find((r) => r.id === "architect")?.route).toMatchObject({ model: "anthropic/claude-opus-5-5", effort: "xhigh" });
    const cfr = claude.rows.find((r) => r.id === "final-review")!;
    expect(cfr.route).toMatchObject({ agent: "codex", model: "gpt-6-astra", provider_id: "art-cindy", effort: "xhigh" });
    expect(cfr.model.options[0]).toMatchObject({ value: "", label: "同方案" });
    expect(cfr.model.groups.flatMap((g) => g.options).some((o) => o.value.includes("gpt-6-luna"))).toBe(true);
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

  it("setFinalReviewRoute round-trips through the view and 同方案 drops the field", () => {
    const models = appendixCAgentModels();
    const saved = setFinalReviewRoute(DEFAULT_MANUAL, "sol", { agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy", effort: "high" });
    const row = buildSettingsView(saved, { harness: "codex", taskType: "default" }, models).rows.find((r) => r.id === "final-review")!;
    expect(row.model.value).toBe("gpt-6-luna\tart-cindy");
    const self = setFinalReviewRoute(saved, "sol", undefined);
    expect("final_review_route" in self.profiles[0]!).toBe(false);
    const again = buildSettingsView(self, { harness: "codex", taskType: "default" }, models).rows.find((r) => r.id === "final-review")!;
    expect(again.model.value).toBe("");
    expect(again.model.options[0]?.label).toBe("同方案");
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
    expect(shouldRefreshCatalogOnOpen({ act: "fb-agent", programmatic: false })).toBe(true);
    expect(shouldRefreshCatalogOnOpen({ act: "fb-model", programmatic: false })).toBe(true);
    expect(shouldRefreshCatalogOnOpen({ act: "fb-effort", programmatic: false })).toBe(true);
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
    expect(fbHtml).not.toContain("备用：");
    expect(fbHtml).toContain(`· ${XSS_ESCAPED} · ${XSS_ESCAPED}`);

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

    const frJson = JSON.stringify({
      version: 1,
      profiles: [{ ...sol, final_review_route: { agent: "codex", model: XSS, provider_id: XSS, effort: "high" } }, grok],
      defaults_by_harness: base.defaults_by_harness,
    });
    const frParsed = parseImportedJson(frJson);
    expect(frParsed.ok).toBe(true);
    if (!frParsed.ok) return;
    const frModels = [
      ...models,
      model({ id: XSS, agent: "codex", providerId: XSS, name: XSS, providerName: XSS, efforts: ["high"] }),
    ];
    expect(await saveManual(fakeIo(frModels), frParsed.manual, frModels)).toMatchObject({ ok: true });
    const frHtml = rowsHtml(buildSettingsView(frParsed.manual, { harness: "codex", taskType: "default" }, frModels));
    expect(frHtml).not.toMatch(/<img/i);
    expect(frHtml).toContain(XSS_ESCAPED);
  });
});

describe("fallback rows", () => {
  const models = appendixCAgentModels();

  it("shows fallbacks only on the five role rows", () => {
    const view = buildSettingsView(DEFAULT_MANUAL, { harness: "codex", taskType: "default" }, models);
    for (const id of ROLES) {
      const row = view.rows.find((r) => r.id === id)!;
      expect(row.fallbacks?.items).toHaveLength(1);
      expect(row.fallbacks?.canAdd).toBe(true);
    }
    for (const id of ["lead", "direction", "final-review"] as const) {
      expect(view.rows.find((r) => r.id === id)?.fallbacks).toBeUndefined();
    }
    const html = rowsHtml(view);
    expect(html).not.toMatch(/data-act="toggle-fb" data-row="lead"/);
    expect(html).not.toMatch(/data-act="toggle-fb" data-row="direction"/);
    expect(html).not.toMatch(/data-act="toggle-fb" data-row="final-review"/);
    expect(html).not.toMatch(/id="fb-panel-lead"/);
    expect(html).not.toMatch(/id="fb-panel-direction"/);
    expect(html).not.toMatch(/id="fb-panel-final-review"/);
  });

  it("renders explorer chip with count and first model, without 等", () => {
    const view = buildSettingsView(DEFAULT_MANUAL, { harness: "codex", taskType: "default" }, models);
    const html = renderRowHtml(view.rows.find((r) => r.id === "explorer")!, "default");
    expect(html).toContain('data-act="toggle-fb" data-row="explorer"');
    expect(html).toContain('<span class="n">1</span>');
    expect(html).toContain("openai/gpt-6-luna · xd");
    expect(html).not.toContain(" 等");
  });

  it("disables add when two fallbacks are set and shows 等", () => {
    const two = setSlot(DEFAULT_MANUAL, "sol", "default", "explorer", {
      primary: DEFAULT_MANUAL.profiles[0]!.nodes.default!.explorer!.primary,
      fallbacks: [
        { agent: "codex", model: "openai/gpt-6-luna", provider_id: "xd", effort: "medium" },
        { agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy", effort: "medium" },
      ],
    });
    const row = buildSettingsView(two, { harness: "codex", taskType: "default" }, models).rows.find((r) => r.id === "explorer")!;
    expect(row.fallbacks?.items).toHaveLength(2);
    expect(row.fallbacks?.canAdd).toBe(false);
    const html = renderRowHtml(row, "default");
    expect(html).toContain('<span class="n">2</span>');
    expect(html).toContain(" 等");
    expect(html).toMatch(/data-act="add-fb"[^>]*disabled/);
    expect(html).toContain("已满 2 条");
  });

  it("shows empty chip on grok explorer with no fallbacks", () => {
    const view = buildSettingsView(DEFAULT_MANUAL, { harness: "claude-code", taskType: "default" }, models);
    const html = renderRowHtml(view.rows.find((r) => r.id === "explorer")!, "default");
    expect(html).toContain("fb-chip empty");
    expect(html).toContain("＋ 设置备用");
  });

  it("marks the row open only when asked", () => {
    const view = buildSettingsView(DEFAULT_MANUAL, { harness: "codex", taskType: "default" }, models);
    const row = view.rows.find((r) => r.id === "explorer")!;
    const open = renderRowHtml(row, "default", true);
    expect(open).toContain("row open");
    expect(open).toContain('aria-expanded="true"');
    const closed = renderRowHtml(row, "default");
    expect(closed).not.toContain("row open");
    expect(closed).toContain('aria-expanded="false"');
  });

  it("renders panel items with fb selects and delete", () => {
    const view = buildSettingsView(DEFAULT_MANUAL, { harness: "codex", taskType: "default" }, models);
    const html = renderRowHtml(view.rows.find((r) => r.id === "explorer")!, "default");
    expect(html).toContain("第 1 备");
    expect(html).toContain('data-act="fb-agent" data-row="explorer" data-i="0"');
    expect(html).toContain('data-act="fb-model" data-row="explorer" data-i="0"');
    expect(html).toContain('data-act="fb-effort" data-row="explorer" data-i="0"');
    expect(html).toContain('data-act="del-fb" data-row="explorer" data-i="0"');
  });

  it("shows 选择模型 and stale on an empty fallback", () => {
    const empty = setSlot(DEFAULT_MANUAL, "sol", "default", "explorer", {
      primary: DEFAULT_MANUAL.profiles[0]!.nodes.default!.explorer!.primary,
      fallbacks: [{ agent: "codex", model: "", provider_id: "" }],
    });
    const row = buildSettingsView(empty, { harness: "codex", taskType: "default" }, models).rows.find((r) => r.id === "explorer")!;
    expect(row.fallbacks?.items[0]?.stale).toBeTruthy();
    const html = renderRowHtml(row, "default");
    expect(html).toContain("fb-item stale");
    expect(html).toMatch(/<option value="" selected disabled>选择模型<\/option>/);
  });

  it("keeps inherited fallbacks read-only on locked task-type rows", () => {
    const view = buildSettingsView(DEFAULT_MANUAL, { harness: "codex", taskType: "bug-fix" }, models);
    const worker = view.rows.find((r) => r.id === "worker")!;
    expect(worker.locked).toBe(true);
    expect(worker.fallbacks?.items).toHaveLength(1);
    expect(worker.fallbacks?.disabled).toBe(true);
    expect(worker.fallbacks?.canAdd).toBe(false);
    const html = renderRowHtml(worker, "bug-fix");
    expect(html).toContain('<span class="n">1</span>');
    expect(html).toMatch(/data-act="fb-agent"[^>]*disabled/);
    expect(html).toMatch(/data-act="fb-model"[^>]*disabled/);
    expect(html).toMatch(/data-act="fb-effort"[^>]*disabled/);
    expect(html).toMatch(/data-act="add-fb"[^>]*disabled/);
    expect(html).toContain("点「单独设置」后可改");
  });
});
