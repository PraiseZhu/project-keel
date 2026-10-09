import { describe, expect, it } from "vitest";
import { invalidateRuntimeConfig, loadRuntimeConfig } from "../../src/main/config.ts";
import {
  addProfile,
  canDeleteProfile,
  cellView,
  composeKv,
  copyProfile,
  deleteProfile,
  fetchCatalog,
  parseImportedJson,
  prettyExport,
  profileList,
  readCatalog,
  routeFromModel,
  saveManual,
  setHarnessDefault,
  setSlot,
  staleReason,
  type SettingsIO,
} from "../../src/panel/manual-editor.ts";
import { cloneManual, DEFAULT_MANUAL, type AgentModel, type ModelManual } from "../../src/shared/manual/schema.ts";
import { appendixCAgentModels } from "../manual/model-manual.test.ts";
import { fakeHost } from "../helpers/fakeHost.ts";
import type { KeelProfile } from "../../src/shared/types.ts";

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
});

describe("profile list mutations", () => {
  it("refuses to delete a profile that others inherit", () => {
    const gate = canDeleteProfile(DEFAULT_MANUAL, "sol");
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toMatch(/解除继承/);
    const deleted = deleteProfile(DEFAULT_MANUAL, "sol");
    expect(deleted).toEqual({ error: expect.stringMatching(/解除继承/) });
    const grok = deleteProfile(DEFAULT_MANUAL, "grok");
    expect("manual" in grok).toBe(true);
  });

  it("add / copy / set default keeps one default per harness", () => {
    const added = addProfile(DEFAULT_MANUAL);
    expect(added.manual.profiles.some((p) => p.id === added.id && p.inherit === "sol")).toBe(true);
    const copied = copyProfile(added.manual, "sol");
    expect(copied.id).not.toBe("sol");
    expect(copied.manual.defaults_by_harness.codex).toBe("sol");
    const next = setHarnessDefault(copied.manual, copied.id, true);
    expect(next.defaults_by_harness.codex).toBe(copied.id);
    expect(profileList(next, copied.id).filter((p) => p.defaultOf === "codex")).toHaveLength(1);
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

describe("stale cells", () => {
  it("marks a saved route missing from the live catalog", () => {
    const reason = staleReason(
      { agent: "codex", model: "gone", provider_id: "art-cindy", effort: "high" },
      appendixCAgentModels(),
    );
    expect(reason).toMatch(/不存在/);
    const cell = cellView(DEFAULT_MANUAL, "sol", "default", "worker", appendixCAgentModels(), false);
    expect(cell.inherit).toBe(false);
    expect(cell.primary?.stale).toBeUndefined();
  });
});

describe("saveManual", () => {
  it("does not PUT when validate fails", async () => {
    const broken = cloneManual(DEFAULT_MANUAL);
    (broken.profiles[0]!.nodes.default!.worker as { primary: { model: string } }).primary.model = "nope";
    const io = fakeIo({ kv: { lanes: [{ repo: "acme/app" }], limits: { concurrentRuns: 2 } }, models: appendixCAgentModels() });
    const result = await saveManual(io, broken, appendixCAgentModels());
    expect(result).toMatchObject({ ok: false, kind: "invalid" });
    expect(io.puts).toEqual([]);
    expect(io.broadcasts).toEqual([]);
    expect(io.kv.lanes).toEqual([{ repo: "acme/app" }]);
  });

  it("PUT failure is not reported as saved and does not broadcast", async () => {
    const io = fakeIo({ kv: { extra: 1 }, models: appendixCAgentModels(), putStatus: 500, putMessage: "quota" });
    const result = await saveManual(io, cloneManual(DEFAULT_MANUAL), appendixCAgentModels());
    expect(result).toEqual({ ok: false, kind: "write", message: "quota" });
    expect(io.broadcasts).toEqual([]);
    expect(io.kv.extra).toBe(1);
  });

  it("replaces only the manual key and keeps the rest of /kv", async () => {
    const io = fakeIo({
      kv: { lanes: [{ repo: "keep/me" }], limits: { concurrentRuns: 9 }, note: "stay" },
      models: appendixCAgentModels(),
    });
    const result = await saveManual(io, cloneManual(DEFAULT_MANUAL), appendixCAgentModels());
    expect(result).toEqual({ ok: true });
    expect(io.broadcasts).toEqual([{ type: "manual-changed" }]);
    expect(io.kv).toMatchObject({ lanes: [{ repo: "keep/me" }], limits: { concurrentRuns: 9 }, note: "stay" });
    expect((io.kv.manual as ModelManual).profiles.map((p) => p.id)).toEqual(["sol", "grok"]);
    expect(Object.keys(composeKv({ a: 1, manual: "old" }, DEFAULT_MANUAL)).sort()).toEqual(["a", "manual"]);
  });

  it("restore-default path validates then writes DEFAULT_MANUAL", async () => {
    const io = fakeIo({ kv: { manual: { version: 1, profiles: [], defaults_by_harness: {} }, keep: true }, models: appendixCAgentModels() });
    const result = await saveManual(io, cloneManual(DEFAULT_MANUAL), appendixCAgentModels());
    expect(result.ok).toBe(true);
    expect(io.kv.keep).toBe(true);
    expect(io.kv.manual).toEqual(DEFAULT_MANUAL);
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

describe("slot inherit", () => {
  it("clearing a cell stores 沿用 (no own slot)", () => {
    const next = setSlot(DEFAULT_MANUAL, "sol", "default", "explorer", undefined);
    expect(next.profiles[0]!.nodes.default!.explorer).toBeUndefined();
    expect(cellView(next, "sol", "default", "explorer", appendixCAgentModels(), false).inherit).toBe(true);
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
    const cached = await loadRuntimeConfig(h, built);
    expect(cached.lanes).toEqual([{ repo: "one/repo", preset: "personal" }]);
    expect(h.kvReads).toBe(1);
    invalidateRuntimeConfig();
    const again = await loadRuntimeConfig(h, built);
    expect(again.lanes).toEqual([{ repo: "two/repo", preset: "personal" }]);
    expect(h.kvReads).toBe(2);
  });
});
