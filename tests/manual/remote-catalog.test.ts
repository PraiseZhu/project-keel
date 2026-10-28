import { describe, expect, it } from "vitest";
import { cloneManual, DEFAULT_MANUAL, type Profile } from "../../src/shared/manual/schema.ts";
import {
  collectManualDeviceIds,
  loadRemoteCatalog,
  REMOTE_UNAVAILABLE_NOTE,
  type CatalogFetch,
} from "../../src/shared/manual/remote-catalog.ts";

const localModel = { id: "gpt-6.1-sol", agent: "codex", providerId: "art-cindy", visible: true };
const remoteModel = { id: "anthropic/claude-opus-5-5", agent: "claude-code", providerId: "anthropic", visible: true };
const DEVICE = "device-claude-aaaaaaaa";

function fetchMap(map: Record<string, { status: number; body?: unknown } | Error>): CatalogFetch {
  return async (url) => {
    const hit = map[url];
    if (hit instanceof Error) throw hit;
    if (!hit) return { status: 404, body: {} };
    return hit;
  };
}

describe("loadRemoteCatalog", () => {
  it("keeps the local list and notes when locations are missing", async () => {
    const catalog = await loadRemoteCatalog(fetchMap({
      "/agent-models": { status: 200, body: { ok: true, models: [localModel] } },
    }));
    expect(catalog).toMatchObject({ ok: true, status: 200, catalogNote: REMOTE_UNAVAILABLE_NOTE, unreadDevices: [] });
    expect(catalog.models).toEqual([localModel]);
    expect(catalog.models[0]).not.toHaveProperty("agentDeviceId");
  });

  it("uses only the local list when a parameterized request returns 400", async () => {
    const catalog = await loadRemoteCatalog(fetchMap({
      "/agent-models": { status: 200, body: { ok: true, models: [localModel], locations: [{ agentDeviceId: DEVICE, name: "Claude" }] } },
      ["/agent-models?agent_device_id=" + DEVICE]: { status: 400, body: { ok: false } },
    }));
    expect(catalog.models).toEqual([localModel]);
    expect(catalog.catalogNote).toBe(REMOTE_UNAVAILABLE_NOTE);
    expect(catalog.unreadDevices).toEqual([{ agentDeviceId: DEVICE, name: "Claude" }]);
  });

  it("uses only the local list when a parameterized request returns 404", async () => {
    const catalog = await loadRemoteCatalog(fetchMap({
      "/agent-models": { status: 200, body: { ok: true, models: [localModel], locations: [{ agentDeviceId: DEVICE, name: "Claude" }] } },
      ["/agent-models?agent_device_id=" + DEVICE]: { status: 404, body: {} },
    }));
    expect(catalog.models).toEqual([localModel]);
    expect(catalog.catalogNote).toBe(REMOTE_UNAVAILABLE_NOTE);
  });

  it("keeps reading the next device when an earlier device returns 404", async () => {
    const other = "device-claude-bbbbbbbb";
    const catalog = await loadRemoteCatalog(fetchMap({
      "/agent-models": {
        status: 200,
        body: {
          ok: true,
          models: [localModel],
          locations: [{ agentDeviceId: DEVICE, name: "Claude" }, { agentDeviceId: other, name: "Air" }],
        },
      },
      ["/agent-models?agent_device_id=" + DEVICE]: { status: 404, body: {} },
      ["/agent-models?agent_device_id=" + other]: { status: 200, body: { ok: true, agentDeviceId: other, models: [remoteModel] } },
    }));
    expect(catalog.models).toEqual([localModel, { ...remoteModel, agentDeviceId: other, deviceName: "Air" }]);
    expect(catalog.unreadDevices).toEqual([{ agentDeviceId: DEVICE, name: "Claude" }]);
    expect(catalog.catalogNote).toBeUndefined();
  });

  it("drops a remote list whose echoed agentDeviceId does not match the request", async () => {
    const catalog = await loadRemoteCatalog(fetchMap({
      "/agent-models": { status: 200, body: { ok: true, models: [localModel], locations: [{ agentDeviceId: DEVICE, name: "Claude" }] } },
      ["/agent-models?agent_device_id=" + DEVICE]: { status: 200, body: { ok: true, agentDeviceId: "other", models: [remoteModel] } },
    }));
    expect(catalog.models).toEqual([localModel]);
    expect(catalog.unreadDevices).toEqual([{ agentDeviceId: DEVICE, name: "Claude" }]);
    expect(catalog.catalogNote).toBeUndefined();
  });

  it("stamps remote items with agentDeviceId and deviceName", async () => {
    const catalog = await loadRemoteCatalog(fetchMap({
      "/agent-models": { status: 200, body: { ok: true, models: [localModel], locations: [{ agentDeviceId: DEVICE, name: "Claude" }] } },
      ["/agent-models?agent_device_id=" + DEVICE]: { status: 200, body: { ok: true, agentDeviceId: DEVICE, models: [remoteModel] } },
    }));
    expect(catalog.catalogNote).toBeUndefined();
    expect(catalog.models).toEqual([
      localModel,
      { ...remoteModel, agentDeviceId: DEVICE, deviceName: "Claude" },
    ]);
  });

  it("marks a 503 remote device unread and keeps local items", async () => {
    const catalog = await loadRemoteCatalog(fetchMap({
      "/agent-models": { status: 200, body: { ok: true, models: [localModel], locations: [{ agentDeviceId: DEVICE, name: "Claude" }] } },
      ["/agent-models?agent_device_id=" + DEVICE]: { status: 503, body: { ok: false, errorCode: "NOT_AVAILABLE" } },
    }));
    expect(catalog.ok).toBe(true);
    expect(catalog.models).toEqual([localModel]);
    expect(catalog.unreadDevices).toEqual([{ agentDeviceId: DEVICE, name: "Claude" }]);
  });

  it("uses the first 8 characters of the device id when locations omit the name", async () => {
    const catalog = await loadRemoteCatalog(fetchMap({
      "/agent-models": { status: 200, body: { ok: true, models: [localModel] } },
    }), { deviceIds: [DEVICE] });
    expect(catalog.unreadDevices[0]?.name).toBe(DEVICE.slice(0, 8));
  });

  it("treats a network error on the local list as a failed catalog", async () => {
    const catalog = await loadRemoteCatalog(fetchMap({
      "/agent-models": new Error("offline"),
    }));
    expect(catalog).toMatchObject({ ok: false, status: 0, models: [], catalogNote: REMOTE_UNAVAILABLE_NOTE });
  });
});

describe("collectManualDeviceIds", () => {
  it("collects non-local devices from the profile inherit chain", () => {
    const manual = cloneManual(DEFAULT_MANUAL);
    const sol = manual.profiles.find((p) => p.id === "sol") as Profile;
    (sol as { nodes: Profile["nodes"] }).nodes = {
      default: {
        ...sol.nodes.default,
        worker: { primary: { agent: "codex", model: "gpt-6.1-sol", provider_id: "art-cindy", agent_device_id: DEVICE } },
      },
    };
    expect(collectManualDeviceIds(manual, "sol")).toEqual([DEVICE]);
    expect(collectManualDeviceIds(manual, "grok")).toEqual([]);
  });
});
