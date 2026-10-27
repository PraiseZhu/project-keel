import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { invalidateRuntimeConfig, loadRuntimeConfig } from "../../src/main/config.ts";
import {
  composeKv,
  fetchCatalog,
  fingerprintManual,
  loadManualFromKv,
  parseImportedJson,
  prettyExport,
  readCatalog,
  routeFromModel,
  saveManual,
  staleReason,
  type SettingsIO,
} from "../../src/panel/manual-editor.ts";
import { cloneManual, DEFAULT_MANUAL, type AgentModel, type ModelManual } from "../../src/shared/manual/schema.ts";
import { setCodeRoutes } from "../../src/shared/manual/stages.ts";
import { fakeHost } from "../helpers/fakeHost.ts";
import type { KeelProfile } from "../../src/shared/types.ts";
import { stageCatalog } from "./stage-catalog.ts";

const here = dirname(fileURLToPath(import.meta.url));
const models = stageCatalog();

function model(partial: AgentModel): AgentModel {
  return { name: partial.id, visible: true, ...partial };
}

function fakeIo(opts: {
  kv?: Record<string, unknown>;
  models?: readonly AgentModel[];
  getStatus?: number;
  putStatus?: number;
  putMessage?: string;
}): SettingsIO & { kv: Record<string, unknown>; puts: Record<string, unknown>[]; broadcasts: unknown[] } {
  const kv: Record<string, unknown> = { ...(opts.kv ?? {}) };
  const puts: Record<string, unknown>[] = [];
  const broadcasts: unknown[] = [];
  return {
    kv, puts, broadcasts,
    async getKv() { return { ...kv }; },
    async putKv(next) {
      puts.push({ ...next });
      if ((opts.putStatus ?? 204) !== 204) return { ok: false, status: opts.putStatus ?? 500, message: opts.putMessage ?? "disk full" };
      for (const k of Object.keys(kv)) delete kv[k];
      Object.assign(kv, next);
      return { ok: true, status: 204 };
    },
    async getAgentModels() {
      return { status: opts.getStatus ?? 200, body: { ok: true, models: opts.models ?? [] } };
    },
    broadcast(message) { broadcasts.push(message); },
  };
}

describe("catalog 404 / 503", () => {
  it("404 asks to upgrade Cindy; 503 offers retry", async () => {
    expect(readCatalog(404, {})).toMatchObject({ status: "upgrade", retry: false, models: [] });
    expect(readCatalog(404, {}).message).toMatch(/升级 Cindy/);
    expect(readCatalog(503, {})).toMatchObject({ status: "retry", retry: true });
    expect(readCatalog(503, {}).message).toMatch(/503/);
    const io = fakeIo({ getStatus: 503 });
    const cat = await fetchCatalog(io);
    expect(cat.retry).toBe(true);
  });

  it("notes when Cindy cannot read other computers and keeps the local list", async () => {
    const io = fakeIo({ models });
    const cat = await fetchCatalog(io);
    expect(cat.status).toBe("ok");
    expect(cat.models).toEqual(models);
    expect(cat.catalogNote).toMatch(/不能读取其他电脑的模型/);
  });
});

describe("empty efforts omit effort", () => {
  it("routeFromModel does not write effort when efforts is empty", () => {
    const undeclared = model({ id: "plain", agent: "codex", providerId: "art-cindy", efforts: [] });
    const route = routeFromModel(undeclared, "high");
    expect(route).toEqual({ agent: "codex", model: "plain", provider_id: "art-cindy" });
    expect("effort" in route).toBe(false);
    const declared = model({ id: "gpt-6-luna", agent: "codex", providerId: "art-cindy", efforts: ["low", "high"] });
    expect(routeFromModel(declared, "high").effort).toBe("high");
    expect("effort" in routeFromModel(declared, undefined)).toBe(false);
  });
});

describe("stale routes", () => {
  it("marks a saved route missing from the live catalog, and an effort the model does not declare", () => {
    expect(staleReason({ agent: "codex", model: "gone", provider_id: "art-cindy", effort: "high" }, models)).toMatch(/不存在/);
    expect(staleReason(DEFAULT_MANUAL.profiles[0]!.nodes.default!.worker!.primary, models)).toBeUndefined();
    expect(staleReason({ agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy", effort: "high" }, models)).toMatch(/未声明档位/);
    expect(staleReason({ agent: "codex", model: "gpt-6.1-sol", provider_id: "art-cindy", effort: "ultra" }, models)).toMatch(/不在该项已声明的 efforts/);
  });
});


describe("saveManual", () => {
  const nope = { agent: "codex", model: "nope", provider_id: "art-cindy", effort: "high" } as const;

  it("does not PUT when validate fails", async () => {
    const broken = setCodeRoutes(DEFAULT_MANUAL, "sol", nope);
    const io = fakeIo({ kv: { lanes: [{ repo: "acme/app" }], limits: { concurrentRuns: 2 } }, models });
    const result = await saveManual(io, broken, models);
    expect(result).toMatchObject({ ok: false, kind: "invalid" });
    expect(io.puts).toEqual([]);
    expect(io.broadcasts).toEqual([]);
    expect(io.kv.lanes).toEqual([{ repo: "acme/app" }]);
  });

  it("PUT failure is not reported as saved and does not broadcast", async () => {
    const io = fakeIo({ kv: { extra: 1 }, models, putStatus: 500, putMessage: "quota" });
    const result = await saveManual(io, cloneManual(DEFAULT_MANUAL), models);
    expect(result).toEqual({ ok: false, kind: "write", message: "quota" });
    expect(io.broadcasts).toEqual([]);
    expect(io.kv.extra).toBe(1);
  });

  it("replaces only the manual key and keeps the rest of /kv", async () => {
    const io = fakeIo({ kv: { lanes: [{ repo: "keep/me" }], limits: { concurrentRuns: 9 }, note: "stay" }, models });
    const result = await saveManual(io, cloneManual(DEFAULT_MANUAL), models);
    expect(result).toEqual({ ok: true });
    expect(io.broadcasts).toEqual([{ type: "manual-changed" }]);
    expect(io.kv).toMatchObject({ lanes: [{ repo: "keep/me" }], limits: { concurrentRuns: 9 }, note: "stay" });
    expect((io.kv.manual as ModelManual).profiles.map((p) => p.id)).toEqual(["sol", "grok"]);
    expect(Object.keys(composeKv({ a: 1, manual: "old" }, DEFAULT_MANUAL)).sort()).toEqual(["a", "manual"]);
  });

  it("restore-default path validates then writes DEFAULT_MANUAL", async () => {
    const io = fakeIo({ kv: { manual: { version: 1, profiles: [], defaults_by_harness: {} }, keep: true }, models });
    const result = await saveManual(io, cloneManual(DEFAULT_MANUAL), models);
    expect(result.ok).toBe(true);
    expect(io.kv.keep).toBe(true);
    expect(io.kv.manual).toEqual({ ...DEFAULT_MANUAL, version: 2 });
  });

  it("rejects what the stage rules forbid, with a reason per row", async () => {
    const pi = setCodeRoutes(DEFAULT_MANUAL, "sol", { agent: "pi", model: "grok-4.6", provider_id: "art-cindy", effort: "high" });
    const sameHarness = setCodeRoutes(DEFAULT_MANUAL, "sol", { agent: "claude-code", model: "anthropic/claude-sonnet-5-5", provider_id: "xd", effort: "high" });
    const io = fakeIo({ kv: { keep: true }, models });
    const a = await saveManual(io, pi, models);
    expect(a).toMatchObject({ ok: false, kind: "invalid" });
    if (!a.ok && a.kind === "invalid") expect(a.issues.some((i) => i.message.includes("Pi 不用于 KEEL 派工"))).toBe(true);
    const b = await saveManual(io, sameHarness, models);
    expect(b).toMatchObject({ ok: false, kind: "invalid" });
    if (!b.ok && b.kind === "invalid") expect(b.issues.some((i) => i.message.includes("做检查要和写代码不是同一家"))).toBe(true);
    expect(io.puts).toEqual([]);
  });

  it("does not let an unused stale profile block saving a changed route", async () => {
    const base = cloneManual(DEFAULT_MANUAL);
    const stale: ModelManual = {
      ...base,
      profiles: [...base.profiles, {
        id: "stale-old",
        name: "旧方案",
        harness: "codex",
        lead: base.profiles[0]!.lead,
        direction_gate: "lead",
        nodes: { default: { ...base.profiles[0]!.nodes.default!, worker: { primary: { agent: "codex", model: "gone-model", provider_id: "art-cindy", effort: "high" } } } },
      }],
    };
    const edited = setCodeRoutes(stale, "sol", { agent: "codex", model: "gpt-6-astra", provider_id: "art-cindy", effort: "high" }, { agent: "codex", model: "openai/gpt-6-astra", provider_id: "xd", effort: "high" });
    const io = fakeIo({ kv: { extra: 1, manual: stale }, models });
    const result = await saveManual(io, edited, models, { expectedFingerprint: fingerprintManual(stale), baseline: stale });
    expect(result).toEqual({ ok: true });
    expect(io.kv.extra).toBe(1);
    expect((io.kv.manual as ModelManual).version).toBe(2);
    const withoutBaseline = await saveManual(fakeIo({ kv: { manual: stale }, models }), edited, models);
    expect(withoutBaseline).toMatchObject({ ok: false, kind: "invalid" });
  });

  it("blocks a changed invalid effort even when the availability message is unchanged", async () => {
    const luna = (effort: string) => ({ agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy", effort }) as const;
    const loaded = setCodeRoutes(cloneManual(DEFAULT_MANUAL), "sol", luna("high"));
    const edited = setCodeRoutes(loaded, "sol", luna("max"));
    const io = fakeIo({ kv: { extra: 1, manual: loaded }, models });
    const result = await saveManual(io, edited, models, { expectedFingerprint: fingerprintManual(loaded), baseline: loaded });
    expect(result).toMatchObject({ ok: false, kind: "invalid" });
    if (!result.ok && result.kind === "invalid") expect(result.issues.some((i) => i.message.includes("未声明档位"))).toBe(true);
    expect(io.kv.extra).toBe(1);
    expect(io.kv.manual).toEqual(loaded);
  });

  it("refuses to save over a manual that changed since it was loaded", async () => {
    const io = fakeIo({ kv: { manual: DEFAULT_MANUAL }, models });
    const result = await saveManual(io, cloneManual(DEFAULT_MANUAL), models, { expectedFingerprint: "stale", baseline: DEFAULT_MANUAL });
    expect(result).toMatchObject({ ok: false, kind: "conflict" });
    expect(io.puts).toEqual([]);
  });

  it("refuses to treat an invalid stored manual as loaded default", async () => {
    const io = fakeIo({ kv: { manual: { version: 9 }, keep: true } });
    const loaded = await loadManualFromKv(io);
    expect(loaded.invalid).toBe(true);
    expect(loaded.fingerprint).toMatch(/^raw:/);
    expect(io.kv.manual).toEqual({ version: 9 });
    expect(io.kv.keep).toBe(true);
  });
});

describe("import / export", () => {
  it("pretty export round-trips; invalid import is rejected before save", () => {
    const text = prettyExport(DEFAULT_MANUAL);
    const parsed = parseImportedJson(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.manual).toEqual(DEFAULT_MANUAL);
    expect(parseImportedJson("{")).toMatchObject({ ok: false });
    expect(parseImportedJson("{\"version\":2}")).toMatchObject({ ok: false });
  });
});

describe("RuntimeConfig cache hook", () => {
  const built: KeelProfile = { lanes: [{ repo: "acme/app", preset: "personal" }], routingPath: null, boardRepos: [], plansDir: null };

  it("invalidateRuntimeConfig drops the cache even when it was empty", async () => {
    invalidateRuntimeConfig();
    const h = fakeHost({ kv: { lanes: [{ repo: "one/repo", preset: "personal" }] } });
    const first = await loadRuntimeConfig(h, built);
    expect(first.lanes).toEqual([{ repo: "one/repo", preset: "personal" }]);
    h.kv.lanes = [{ repo: "two/repo", preset: "personal" }];
    const live = await loadRuntimeConfig(h, built);
    expect(live.lanes).toEqual([{ repo: "two/repo", preset: "personal" }]);
    expect(h.kvReads).toBeGreaterThanOrEqual(2);
    invalidateRuntimeConfig();
    const again = await loadRuntimeConfig(h, built);
    expect(again.lanes).toEqual([{ repo: "two/repo", preset: "personal" }]);
  });
});


function readPlugin(name: string): string {
  return readFileSync(join(here, "../../plugin", name), "utf8");
}

describe("settings.html structure", () => {
  const html = readPlugin("settings.html");

  it("has two tabs, the four-row card, the status strip and the kept accordions", () => {
    for (const id of ["status-bar", "model-tabs", "model-rows", "stage-notice", "manual-status", "reply-seg", "accordion-jev", "accordion-lanes", "accordion-advanced", "advanced-body"]) {
      expect(html).toContain(`id="${id}"`);
    }
    for (const id of ["jev", "catalog", "hooks", "clock"]) {
      expect(html).toContain(`data-status="${id}"`);
      expect(html).toContain(`id="status-${id}-dot"`);
      expect(html).toContain(`id="status-${id}-value"`);
    }
    expect(html).toContain("KEEL 设置");
    expect(html).toContain("这里只决定 KEEL 怎么派活，不会改你当前会话的模型。");
    expect(html.match(/data-harness="/g)).toHaveLength(2);
    expect(html).toMatch(/class="on" data-harness="claude-code"[^>]*>我用 Claude Code 时</);
    expect(html).toMatch(/data-harness="codex"[^>]*>我用 Codex 时</);
    expect(html).toContain("评审回帖");
  });

  it("no longer carries the removed controls or explanations", () => {
    for (const gone of [
      "筛选", "角色细调", "按任务类型", "协作模型", "高级范围", "主控方案", "方案管理", "配置规则", "只读协作", "当前说明书",
      "task-scope", "scope-banner", "lead-row", "model-hint", "config-help", "taskbar", "accordion-scope",
      "roles-refresh", "5×6", "模型档次表",
      "每个下拉框打开时", "改完点保存", "读取中", 'id="reply-confirm"', "前往 Typesafe 控制台",
    ]) {
      expect(html).not.toContain(gone);
    }
  });

  it("keeps only export, import and restore under 高级", () => {
    const advanced = html.slice(html.indexOf('id="advanced-body"'), html.indexOf("</details>", html.indexOf('id="advanced-body"')));
    expect(advanced.match(/data-act="/g)).toHaveLength(3);
    for (const act of ["export", "import", "restore"]) expect(advanced).toContain(`data-act="${act}"`);
    for (const gone of ["新增", "复制", "删除", "改名", "沿用", "主控环境"]) expect(advanced).not.toContain(gone);
    expect(html.indexOf('data-act="restore"')).toBeGreaterThan(html.indexOf('id="accordion-advanced"'));
  });

  it("starts with Save disabled; the script enables it only while there are unsaved edits", () => {
    expect(html).toMatch(/data-act="save" disabled/);
  });
});

describe("settings.css", () => {
  const css = readPlugin("settings.css");

  it("has no red text left except the save-failure status, and no styles for the removed controls", () => {
    expect(css.match(/--danger/g)).toHaveLength(1);
    expect(css).toMatch(/#manual-status\.issues \{ color:var\(--danger/);
    for (const gone of [".stale-reason", ".route-status", ".mixed", ".filter-model", ".model-group", ".role-editor", ".fb-chip", ".scope-banner", ".config-help"]) {
      expect(css).not.toContain(gone);
    }
    expect(css).toContain(".stage-warn");
    expect(css).toMatch(/\.stage-warn \{[^}]*--warning/);
  });
});
