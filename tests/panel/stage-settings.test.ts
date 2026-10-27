import { describe, expect, it } from "vitest";
import { cloneManual, DEFAULT_MANUAL, type ModelManual, type Route } from "../../src/shared/manual/schema.ts";
import { readStages, setCodeRoutes, setPlanRoute, setReviewRoutes, type StageHarness, type StageId } from "../../src/shared/manual/stages.ts";
import { validateManual } from "../../src/shared/manual/validate.ts";
import {
  addDefaultProfile,
  applyStageChange,
  buildStageView,
  catalogArrivalAction,
  isCatalogReady,
  modelLabel,
  modelValue,
  parseModelValue,
  renderStageRowsHtml,
  routeAfterModelChange,
  type SelectView,
  type SlotId,
  type StageSettingsView,
} from "../../src/panel/stage-settings.ts";
import { stageCatalog, valueOf } from "./stage-catalog.ts";
import { REMOTE_UNAVAILABLE_NOTE } from "../../src/shared/manual/remote-catalog.ts";

const models = stageCatalog();

function view(manual: ModelManual, harness: StageHarness, ready = true): StageSettingsView {
  return buildStageView(manual, harness, models, ready);
}
function row(v: StageSettingsView, id: StageId) {
  return v.rows.find((r) => r.id === id)!;
}
function control(v: StageSettingsView, id: StageId, slot: SlotId, kind: "model" | "effort"): SelectView {
  const r = row(v, id);
  const pair = slot === "primary" ? r.primary : r.fallback!;
  return pair[kind];
}
function offered(sel: SelectView): string[] {
  return sel.groups.flatMap((g) => g.options.map((o) => o.value));
}
function groupLabels(sel: SelectView): string[] {
  return sel.groups.map((g) => g.label);
}
function change(manual: ModelManual, harness: StageHarness, stage: StageId, slot: SlotId, act: "model" | "effort", value: string) {
  return applyStageChange(manual, harness, models, { stage, slot, act, value });
}
const opus = valueOf("claude-code", "anthropic/claude-opus-5-5", "xd");
const sonnet = valueOf("claude-code", "anthropic/claude-sonnet-5-5", "xd");
const solArt = valueOf("codex", "gpt-6.1-sol", "art-cindy");
const solXd = valueOf("codex", "openai/gpt-6.1-sol", "xd");
const astraArt = valueOf("codex", "gpt-6-astra", "art-cindy");
const luna = valueOf("codex", "gpt-6-luna", "art-cindy");

describe("fixture", () => {
  it("both default profiles validate against the fixture catalog", () => {
    expect(validateManual(DEFAULT_MANUAL, models, { manual: DEFAULT_MANUAL })).toEqual([]);
    expect(isCatalogReady({ status: "ok", models })).toBe(true);
    expect(isCatalogReady({ status: "ok", models: [] })).toBe(false);
    expect(isCatalogReady({ status: "retry", models })).toBe(false);
  });
});

describe("model dropdown rules", () => {
  it("想方案 lists only the other harness than the lead, grouped by 执行框架 · 网关", () => {
    const cc = control(view(DEFAULT_MANUAL, "claude-code"), "plan", "primary", "model");
    expect(groupLabels(cc)).toEqual(["Codex · Art Cindy", "Codex · XD Gateway"]);
    expect(offered(cc)).toContain(astraArt);
    expect(cc.groups[0]!.options.map((o) => o.label)).toContain("GPT-6 Astra · Art Cindy");
    const cx = control(view(DEFAULT_MANUAL, "codex"), "plan", "primary", "model");
    expect(groupLabels(cx)).toEqual(["Claude Code · XD Gateway", "Claude Code · Art Cindy"]);
    expect(cx.groups[0]!.options.map((o) => o.label)).toContain("Opus 5.5 · XD Gateway");
  });

  it("never offers Pi, hidden models, or Claude Code + Art Cindy + gpt", () => {
    for (const harness of ["claude-code", "codex"] as const) {
      const v = view(DEFAULT_MANUAL, harness);
      for (const id of ["plan", "code", "review"] as const) {
        const all = offered(control(v, id, "primary", "model"));
        expect(all.some((x) => x.startsWith('["pi"'))).toBe(false);
        expect(all).not.toContain(valueOf("claude-code", "anthropic/claude-old", "xd"));
        expect(all).not.toContain(valueOf("claude-code", "gpt-6.1-sol", "art-cindy"));
      }
    }
  });

  it("写代码 offers both harnesses; its backup only the writer's harness", () => {
    const v = view(DEFAULT_MANUAL, "codex");
    const main = control(v, "code", "primary", "model");
    expect(groupLabels(main)).toEqual(["Claude Code · XD Gateway", "Claude Code · Art Cindy", "Codex · Art Cindy", "Codex · XD Gateway"]);
    const backup = control(v, "code", "fallback", "model");
    expect(groupLabels(backup)).toEqual(["Codex · Art Cindy", "Codex · XD Gateway"]);
    expect(backup.options[0]).toEqual({ value: "", label: "不用备用" });
    expect(backup.value).toBe(solXd);
    const cc = control(view(DEFAULT_MANUAL, "claude-code"), "code", "fallback", "model");
    expect(groupLabels(cc)).toEqual(["Claude Code · XD Gateway", "Claude Code · Art Cindy"]);
  });

  it("做检查 (primary and backup) lists only the harness the writer is not on", () => {
    const codex = view(DEFAULT_MANUAL, "codex");
    expect(groupLabels(control(codex, "review", "primary", "model"))).toEqual(["Claude Code · XD Gateway", "Claude Code · Art Cindy"]);
    expect(groupLabels(control(codex, "review", "fallback", "model"))).toEqual(["Claude Code · XD Gateway", "Claude Code · Art Cindy"]);
    expect(row(codex, "review").description).toBe("写代码用的是 Codex，所以这里只能选 Claude Code");
    const cc = view(DEFAULT_MANUAL, "claude-code");
    expect(groupLabels(control(cc, "review", "primary", "model"))).toEqual(["Codex · Art Cindy", "Codex · XD Gateway"]);
    expect(row(cc, "review").description).toBe("写代码用的是 Claude Code，所以这里只能选 Codex");
  });

  it("the shipped routes are all selected with no warnings", () => {
    for (const harness of ["claude-code", "codex"] as const) {
      const v = view(DEFAULT_MANUAL, harness);
      expect(v.problemCount).toBe(0);
      for (const r of v.rows) expect(r.notes).toEqual([]);
    }
    const v = view(DEFAULT_MANUAL, "codex");
    expect(control(v, "plan", "primary", "model").value).toBe(opus);
    expect(control(v, "code", "primary", "model").value).toBe(solArt);
    expect(control(v, "review", "fallback", "model").value).toBe(sonnet);
  });

  it("查资料 shows the fixed sub for the lead and has no dropdown", () => {
    expect(view(DEFAULT_MANUAL, "claude-code").research).toMatchObject({ title: "查资料", label: "Haiku", description: "主控自带小助手，一次并行派 3 个" });
    expect(view(DEFAULT_MANUAL, "codex").research.label).toBe("gpt-6-luna");
    expect(view(DEFAULT_MANUAL, "codex").rows.map((r) => r.id)).toEqual(["plan", "code", "review"]);
  });
});

describe("effort dropdown", () => {
  it("lists exactly the efforts the model declares", () => {
    const eff = control(view(DEFAULT_MANUAL, "codex"), "code", "primary", "effort");
    expect(eff.options.map((o) => o.value)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(eff.value).toBe("high");
    expect(eff.disabled).toBe(false);
  });

  it("gives only a disabled 默认 when the model declares no efforts", () => {
    const manual = setCodeRoutes(DEFAULT_MANUAL, "sol", { agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy" });
    const eff = control(view(manual, "codex"), "code", "primary", "effort");
    expect(eff.options).toEqual([{ value: "", label: "默认" }]);
    expect(eff.disabled).toBe(true);
  });

  it("shows an unsupported saved effort as 「xx（不支持）」 with a warning, and blocks nothing else", () => {
    const manual = setCodeRoutes(DEFAULT_MANUAL, "sol", { agent: "codex", model: "gpt-6.1-sol", provider_id: "art-cindy", effort: "ultra" });
    const v = view(manual, "codex");
    const eff = control(v, "code", "primary", "effort");
    expect(eff.value).toBe("ultra");
    expect(eff.options.find((o) => o.value === "ultra")).toEqual({ value: "ultra", label: "ultra（不支持）", disabled: true });
    expect(row(v, "code").notes[0]).toMatch(/ultra/);
    expect(v.problemCount).toBe(1);
  });

  it("keeps the old effort on a model change when still supported, else the model default, else none", () => {
    expect(routeAfterModelChange(models, opus, "xhigh")?.effort).toBe("xhigh");
    expect(routeAfterModelChange(models, valueOf("claude-code", "grok-4.6", "art-cindy"), "xhigh")?.effort).toBe("high");
    expect(routeAfterModelChange(models, valueOf("claude-code", "anthropic/claude-haiku-5-5", "xd"), "bogus")).not.toHaveProperty("effort");
    expect(routeAfterModelChange(models, luna, "high")).not.toHaveProperty("effort");
    expect(routeAfterModelChange(models, valueOf("codex", "nope", "xd"), "high")).toBeUndefined();
    const next = change(DEFAULT_MANUAL, "codex", "plan", "primary", "model", sonnet).manual;
    expect(readStages(next, "sol").plan).toEqual({ agent: "claude-code", model: "anthropic/claude-sonnet-5-5", provider_id: "xd", effort: "xhigh" });
  });

  it("an effort change writes only that field", () => {
    const next = change(DEFAULT_MANUAL, "codex", "code", "primary", "effort", "low").manual;
    expect(readStages(next, "sol").code?.primary).toEqual({ agent: "codex", model: "gpt-6.1-sol", provider_id: "art-cindy", effort: "low" });
    expect(readStages(next, "sol").code?.fallbacks).toEqual(DEFAULT_MANUAL.profiles[0]!.nodes.default!.worker!.fallbacks);
  });
});

describe("saved routes that cannot run", () => {
  const pi: Route = { agent: "pi", model: "grok-4.6", provider_id: "art-cindy", effort: "high" };

  it("keeps a disabled 「当前：… （不可用）」 option and explains why", () => {
    const v = view(setCodeRoutes(DEFAULT_MANUAL, "sol", pi), "codex");
    const sel = control(v, "code", "primary", "model");
    const current = sel.options.find((o) => o.value === valueOf("pi", "grok-4.6", "art-cindy"))!;
    expect(current).toMatchObject({ disabled: true });
    expect(current.label).toMatch(/^当前：Grok 4\.6 · Art Cindy · Pi（不可用）$/);
    expect(sel.value).toBe(current.value);
    expect(row(v, "code").notes[0]).toMatch(/Pi 不用于 KEEL 派工/);
    expect(row(v, "code").fallback!.model.disabled).toBe(false);
  });

  it("flags a route on the wrong harness for its row", () => {
    const planOnLead = setPlanRoute(DEFAULT_MANUAL, "sol", { agent: "codex", model: "gpt-6-astra", provider_id: "art-cindy", effort: "xhigh" });
    const v = view(planOnLead, "codex");
    expect(row(v, "plan").notes).toEqual(["这一行只能选 Claude Code 的模型。"]);
    expect(control(v, "plan", "primary", "model").options.some((o) => o.disabled && o.label.startsWith("当前："))).toBe(true);
  });

  it("flags a route the live catalog no longer has, and a backup on another harness", () => {
    const gone = setCodeRoutes(DEFAULT_MANUAL, "sol", { agent: "codex", model: "gpt-9", provider_id: "art-cindy" }, { agent: "claude-code", model: "grok-4.6", provider_id: "art-cindy" });
    const v = view(gone, "codex");
    expect(row(v, "code").notes[0]).toMatch(/gpt-9 在 agent codex/);
    expect(row(v, "code").notes[1]).toMatch(/^备用路线：备用要和主选用同一个执行框架（Codex）/);
    expect(v.problemCount).toBe(2);
  });

  it("locks every control and says so while the catalog is not ready", () => {
    const v = view(DEFAULT_MANUAL, "codex", false);
    expect(v.catalogNote).toMatch(/模型清单暂时读不到/);
    expect(v.problemCount).toBe(0);
    for (const r of v.rows) for (const s of [r.primary.model, r.primary.effort, r.fallback?.model, r.fallback?.effort]) if (s) expect(s.disabled).toBe(true);
    expect(control(v, "code", "primary", "model").value).toBe(solArt);
    expect(renderStageRowsHtml(v)).toContain("模型清单暂时读不到");
  });
});

describe("changing the writer's harness", () => {
  it("clears a backup on the old harness and moves 做检查 to the shipped pairing for the new writer", () => {
    const r = change(DEFAULT_MANUAL, "claude-code", "code", "primary", "model", solArt);
    const s = readStages(r.manual, "grok");
    expect(s.code?.primary).toMatchObject({ agent: "codex", model: "gpt-6.1-sol", effort: "high" });
    expect(s.code?.fallbacks).toBeUndefined();
    const sol = DEFAULT_MANUAL.profiles.find((p) => p.id === "sol")!;
    expect(s.review.primary).toEqual(sol.final_review_route);
    expect(s.review.fallbacks).toEqual(sol.final_review_fallbacks);
    expect(r.notice).toBe("写代码换成了 GPT-6.1 Sol · Art Cindy，写代码的备用已清掉，做检查已自动改成 Opus 5.5 · XD Gateway。");
    expect(validateManual(r.manual, models, { manual: r.manual })).toEqual([]);
  });

  it("goes back to the other shipped pairing when the writer returns to Claude Code", () => {
    const first = change(DEFAULT_MANUAL, "claude-code", "code", "primary", "model", solArt).manual;
    const r = change(first, "claude-code", "code", "primary", "model", sonnet);
    const grok = DEFAULT_MANUAL.profiles.find((p) => p.id === "grok")!;
    expect(readStages(r.manual, "grok").review.primary).toEqual(grok.final_review_route);
    expect(r.notice).toMatch(/做检查已自动改成 GPT-6 Astra · Art Cindy/);
  });

  it("picks the first allowed model when the shipped pairing is not in the catalog", () => {
    const thin = models.filter((m) => !m.id.includes("opus") && !m.id.includes("sonnet") && m.agent !== "pi");
    const r = applyStageChange(DEFAULT_MANUAL, "claude-code", thin, { stage: "code", slot: "primary", act: "model", value: solArt });
    const review = readStages(r.manual, "grok").review;
    expect(review.primary).toMatchObject({ agent: "claude-code", model: "anthropic/claude-haiku-5-5", provider_id: "xd" });
    expect(review.fallbacks).toEqual([]);
  });

  it("says so when nothing is left to pick for 做检查", () => {
    const codexOnly = models.filter((m) => m.agent === "codex");
    const r = applyStageChange(DEFAULT_MANUAL, "claude-code", codexOnly, { stage: "code", slot: "primary", act: "model", value: solArt });
    expect(r.notice).toMatch(/做检查暂时没有可选的模型/);
  });

  it("stays quiet when the writer keeps its harness, and only drops a conflicting review backup", () => {
    const same = change(DEFAULT_MANUAL, "codex", "code", "primary", "model", valueOf("codex", "gpt-6-astra", "art-cindy"));
    expect(same.notice).toBeUndefined();
    expect(readStages(same.manual, "sol").code?.fallbacks).toHaveLength(1);
    const odd = setReviewRoutes(DEFAULT_MANUAL, "grok", DEFAULT_MANUAL.profiles[1]!.final_review_route!, { agent: "claude-code", model: "anthropic/claude-opus-5-5", provider_id: "xd" });
    // The odd backup is on the writer's harness, so changing the writer within Claude Code now drops it too.
    const r = change(odd, "claude-code", "code", "primary", "model", opus);
    expect(r.notice).toContain("做检查的备用已清掉");
    expect(readStages(r.manual, "grok").review.fallbacks).toEqual([]);
    const writer = change(odd, "claude-code", "code", "primary", "model", valueOf("codex", "gpt-6.1-sol", "art-cindy"));
    expect(readStages(writer.manual, "grok").review.primary?.agent).toBe("claude-code");
  });
});

describe("做检查 never shares the writer's model family", () => {
  const grokCodex = valueOf("codex", "grok-4.6", "art-cindy");
  const grokClaude = valueOf("claude-code", "grok-4.6", "art-cindy");

  it("does not offer grok on Claude Code to review grok written on Codex", () => {
    const m = change(DEFAULT_MANUAL, "claude-code", "code", "primary", "model", grokCodex).manual;
    const v = view(m, "claude-code");
    expect(offered(control(v, "review", "primary", "model"))).not.toContain(grokClaude);
    expect(offered(control(v, "review", "fallback", "model"))).not.toContain(grokClaude);
    expect(offered(control(v, "review", "primary", "model"))).toContain(sonnet);
  });

  it("drops a same-family review backup when the writer switches to that family", () => {
    const base = setReviewRoutes(DEFAULT_MANUAL, "grok", { agent: "claude-code", model: "anthropic/claude-sonnet-5-5", provider_id: "xd", effort: "xhigh" }, { agent: "claude-code", model: "grok-4.6", provider_id: "art-cindy", effort: "high" });
    const withCodexWriter = setCodeRoutes(base, "grok", { agent: "codex", model: "gpt-6-astra", provider_id: "art-cindy", effort: "high" });
    const r = change(withCodexWriter, "claude-code", "code", "primary", "model", grokCodex);
    expect(readStages(r.manual, "grok").review.fallbacks).toEqual([]);
    expect(r.notice).toContain("做检查的备用已清掉");
    expect(validateManual(r.manual, models, { manual: r.manual })).toEqual([]);
  });
});

describe("other edits", () => {
  it("想方案 writes architect.primary and drops direction_route", () => {
    const withDirection = cloneManual(DEFAULT_MANUAL);
    (withDirection.profiles[1] as { direction_route?: Route }).direction_route = { agent: "codex", model: "gpt-6-astra", provider_id: "art-cindy" };
    const next = change(withDirection, "claude-code", "plan", "primary", "model", valueOf("codex", "openai/gpt-6-astra", "xd")).manual;
    const grok = next.profiles.find((p) => p.id === "grok")!;
    expect(grok.nodes.default?.architect).toEqual({ primary: { agent: "codex", model: "openai/gpt-6-astra", provider_id: "xd", effort: "xhigh" } });
    expect("direction_route" in grok).toBe(false);
  });

  it("the backups can be cleared with 不用备用, a primary cannot", () => {
    const noCodeBackup = change(DEFAULT_MANUAL, "codex", "code", "fallback", "model", "").manual;
    expect(readStages(noCodeBackup, "sol").code?.fallbacks).toBeUndefined();
    const noReviewBackup = change(DEFAULT_MANUAL, "codex", "review", "fallback", "model", "").manual;
    expect(readStages(noReviewBackup, "sol").review.fallbacks).toEqual([]);
    expect(change(DEFAULT_MANUAL, "codex", "code", "primary", "model", "").manual).toBe(DEFAULT_MANUAL);
    expect(change(DEFAULT_MANUAL, "codex", "code", "primary", "model", valueOf("codex", "nope", "xd")).manual).toBe(DEFAULT_MANUAL);
  });

  it("a backup gets the model it is told and keeps its effort when supported", () => {
    const next = change(DEFAULT_MANUAL, "codex", "code", "fallback", "model", valueOf("codex", "gpt-6-astra", "art-cindy")).manual;
    expect(readStages(next, "sol").code?.fallbacks).toEqual([{ agent: "codex", model: "gpt-6-astra", provider_id: "art-cindy", effort: "high" }]);
  });
});

describe("a harness without a default profile", () => {
  const withoutCodex: ModelManual = { ...cloneManual(DEFAULT_MANUAL), profiles: DEFAULT_MANUAL.profiles.filter((p) => p.id !== "sol"), defaults_by_harness: { "claude-code": "grok" } };

  it("is reported as missing and rendered with a 用默认值 button", () => {
    const v = view(withoutCodex, "codex");
    expect(v.missing).toBe(true);
    expect(v.rows).toEqual([]);
    const html = renderStageRowsHtml(v);
    expect(html).toContain("还没有这个主控的方案");
    expect(html).toContain('data-act="use-default"');
  });

  it("用默认值 adds the shipped profile and makes it the default", () => {
    const next = addDefaultProfile(withoutCodex, "codex");
    expect(next.defaults_by_harness.codex).toBe("sol");
    expect(next.profiles.find((p) => p.id === "sol")).toEqual(DEFAULT_MANUAL.profiles.find((p) => p.id === "sol"));
    expect(view(next, "codex").missing).toBe(false);
  });

  it("picks a unique id when the shipped id is already taken", () => {
    const taken: ModelManual = { ...withoutCodex, profiles: [...withoutCodex.profiles, { ...DEFAULT_MANUAL.profiles[1]!, id: "sol", name: "占位" }] };
    const next = addDefaultProfile(taken, "codex");
    expect(next.defaults_by_harness.codex).toBe("sol-2");
    expect(next.profiles.filter((p) => p.id === "sol")).toHaveLength(1);
    expect(next.profiles.find((p) => p.id === "sol-2")?.harness).toBe("codex");
  });
});

describe("rendering and catalog arrival", () => {
  it("renders the four rows with located, escaped selects", () => {
    const html = renderStageRowsHtml(view(DEFAULT_MANUAL, "claude-code"));
    for (const title of ["查资料", "想方案", "写代码", "做检查"]) expect(html).toContain(`<b>${title}</b>`);
    expect(html).toContain("用不了时换");
    for (const stage of ["plan", "code", "review"]) for (const act of ["model", "effort"]) expect(html).toContain(`data-act="${act}" data-stage="${stage}" data-slot="primary"`);
    expect(html).toContain('data-act="model" data-stage="code" data-slot="fallback"');
    expect(html).toContain("&quot;");
    expect(html).not.toMatch(/data-slot="fallback"[^>]*data-stage="plan"/);
  });

  it("decides what a late catalog does", () => {
    expect(catalogArrivalAction({ seqAccepted: false, interacting: false })).toBe("ignore");
    expect(catalogArrivalAction({ seqAccepted: true, interacting: false, render: false })).toBe("store");
    expect(catalogArrivalAction({ seqAccepted: true, interacting: true })).toBe("defer");
    expect(catalogArrivalAction({ seqAccepted: true, interacting: false })).toBe("store-and-render");
  });
});

describe("remote catalog options", () => {
  const device = "device-claude-aaaaaaaa";
  const remoteOpus = {
    id: "anthropic/claude-opus-5-5",
    name: "Opus 5.5",
    agent: "claude-code",
    providerId: "anthropic",
    providerName: "Anthropic",
    efforts: ["low", "medium", "high", "xhigh", "max"] as const,
    defaultEffort: "high",
    visible: true,
    agentDeviceId: device,
    deviceName: "Claude",
  };
  const mixed = [...models, remoteOpus];

  it("keeps local labels, 3-tuple values, and groups, and labels remote items with the computer name", () => {
    expect(modelLabel(models[0]!)).toBe("Opus 5.5 · XD Gateway");
    expect(modelValue({ agent: "claude-code", model: "anthropic/claude-opus-5-5", provider_id: "xd" })).toBe(opus);
    expect(parseModelValue(opus)).toEqual({ agent: "claude-code", id: "anthropic/claude-opus-5-5", providerId: "xd" });
    expect(modelLabel(remoteOpus)).toBe("Opus 5.5 · Anthropic · Claude");
    const remoteValue = valueOf("claude-code", "anthropic/claude-opus-5-5", "anthropic", device);
    expect(parseModelValue(remoteValue)).toEqual({
      agent: "claude-code", id: "anthropic/claude-opus-5-5", providerId: "anthropic", agentDeviceId: device,
    });
    const v = buildStageView(DEFAULT_MANUAL, "codex", mixed, true);
    const plan = control(v, "plan", "primary", "model");
    expect(groupLabels(plan).slice(0, 2)).toEqual(["Claude Code · XD Gateway", "Claude Code · Art Cindy"]);
    expect(groupLabels(plan)).toContain("Claude");
    expect(plan.groups.find((g) => g.label === "Claude")!.options.map((o) => o.label)).toContain("Opus 5.5 · Anthropic · Claude");
    expect(offered(plan)).toContain(remoteValue);
    expect(offered(plan)).toContain(opus);
  });

  it("round-trips a remote selection and keeps an unread saved route", () => {
    const remoteValue = valueOf("claude-code", "anthropic/claude-opus-5-5", "anthropic", device);
    const next = applyStageChange(DEFAULT_MANUAL, "codex", mixed, { stage: "plan", slot: "primary", act: "model", value: remoteValue });
    expect(readStages(next.manual, "sol").plan).toMatchObject({ agent: "claude-code", model: "anthropic/claude-opus-5-5", provider_id: "anthropic", agent_device_id: device });
    const again = buildStageView(next.manual, "codex", mixed, true);
    expect(control(again, "plan", "primary", "model").value).toBe(remoteValue);
    const unread = buildStageView(next.manual, "codex", models, true);
    const current = control(unread, "plan", "primary", "model").options.find((o) => o.value === remoteValue)!;
    expect(current.disabled).toBe(true);
    expect(current.label).toMatch(/当前：/);
    expect(current.label).toMatch(/Claude/);
    expect(current.label).toMatch(/不可用/);
    expect(control(unread, "plan", "primary", "model").value).toBe(remoteValue);
  });

  it("shows the remote-capability note without clearing local options", () => {
    const v = buildStageView(DEFAULT_MANUAL, "codex", models, true, REMOTE_UNAVAILABLE_NOTE);
    expect(v.catalogNote).toBe(REMOTE_UNAVAILABLE_NOTE);
    expect(control(v, "code", "primary", "model").value).toBe(solArt);
    expect(renderStageRowsHtml(v)).toContain(REMOTE_UNAVAILABLE_NOTE);
  });

  it("names an unread computer with the first 8 characters of the device id", () => {
    const unnamed = { ...remoteOpus, deviceName: undefined as unknown as string };
    const remoteValue = valueOf("claude-code", unnamed.id, unnamed.providerId, device);
    const saved = applyStageChange(DEFAULT_MANUAL, "codex", [...models, unnamed], { stage: "plan", slot: "primary", act: "model", value: remoteValue }).manual;
    const unread = buildStageView(saved, "codex", models, true);
    const current = control(unread, "plan", "primary", "model").options.find((o) => o.value === remoteValue)!;
    expect(current.label).toContain(device.slice(0, 8));
  });
});
