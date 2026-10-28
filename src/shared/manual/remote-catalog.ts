// Merged /agent-models catalog: local items plus optional per-device remote lists.
// Old Cindy returns 400 for any query string; that path keeps the local list.

import { isLocalDevice, routeDeviceId, type AgentModel, type ModelManual, type Route } from "./schema.ts";

export const REMOTE_UNAVAILABLE_NOTE = "当前 Cindy 不能读取其他电脑的模型";

export interface AgentLocation {
  readonly agentDeviceId: string;
  readonly name: string;
}

export interface UnreadDevice {
  readonly agentDeviceId: string;
  readonly name: string;
}

export interface RemoteCatalog {
  readonly ok: boolean;
  readonly status: number;
  readonly models: readonly AgentModel[];
  readonly locations: readonly AgentLocation[];
  readonly unreadDevices: readonly UnreadDevice[];
  readonly catalogNote?: string;
}

export type CatalogFetch = (url: string) => Promise<{ status: number; body?: unknown }>;

export function deviceDisplayName(id: string, locations: readonly AgentLocation[] = []): string {
  const hit = locations.find((item) => item.agentDeviceId === id);
  if (hit?.name) return hit.name;
  return id.slice(0, 8);
}

export function unreadReason(name: string): string {
  return `${name} 的清单读不到`;
}

function asRecord(body: unknown): Record<string, unknown> | undefined {
  return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
}

function parseModels(body: unknown): AgentModel[] {
  const models = asRecord(body)?.models;
  return Array.isArray(models) ? models as AgentModel[] : [];
}

function parseLocations(body: unknown): AgentLocation[] {
  const raw = asRecord(body)?.locations;
  if (!Array.isArray(raw)) return [];
  const out: AgentLocation[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const id = (item as { agentDeviceId?: unknown }).agentDeviceId;
    if (typeof id !== "string" || !id) continue;
    const name = (item as { name?: unknown }).name;
    out.push({ agentDeviceId: id, name: typeof name === "string" && name ? name : id.slice(0, 8) });
  }
  return out;
}

function uniqueIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (isLocalDevice(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function visitRoute(route: Route | undefined, out: Set<string>): void {
  if (!route || isLocalDevice(route.agent_device_id)) return;
  out.add(routeDeviceId(route.agent_device_id));
}

function visitRoutes(routes: readonly Route[] | undefined, out: Set<string>): void {
  for (const route of routes ?? []) visitRoute(route, out);
}

/** Device ids referenced by the profile (and its inherit chain), excluding local. */
export function collectManualDeviceIds(manual: ModelManual, profileId: string): string[] {
  const out = new Set<string>();
  const seen = new Set<string>();
  let cur: string | undefined = profileId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const profile = manual.profiles.find((item) => item.id === cur);
    if (!profile) break;
    visitRoute(profile.lead, out);
    visitRoute(profile.direction_route, out);
    visitRoute(profile.final_review_route, out);
    visitRoutes(profile.final_review_fallbacks, out);
    visitRoutes(profile.direction_collaborators, out);
    visitRoutes(profile.final_review_collaborators, out);
    for (const roles of Object.values(profile.nodes)) {
      if (!roles) continue;
      for (const slot of Object.values(roles)) {
        if (!slot) continue;
        visitRoute(slot.primary, out);
        visitRoutes(slot.fallbacks, out);
        visitRoutes(slot.collaborators, out);
      }
    }
    cur = profile.inherit;
  }
  return [...out];
}

function failed(status: number): RemoteCatalog {
  return { ok: false, status, models: [], locations: [], unreadDevices: [], catalogNote: REMOTE_UNAVAILABLE_NOTE };
}

function unreadOf(id: string, locations: readonly AgentLocation[]): UnreadDevice {
  return { agentDeviceId: id, name: deviceDisplayName(id, locations) };
}

export async function loadRemoteCatalog(fetchJson: CatalogFetch, opts?: { deviceIds?: readonly string[] }): Promise<RemoteCatalog> {
  let local: { status: number; body?: unknown };
  try {
    local = await fetchJson("/agent-models");
  } catch {
    return failed(0);
  }
  if (local.status !== 200) return failed(local.status);

  const localModels = parseModels(local.body);
  const locations = parseLocations(local.body);
  const requested = uniqueIds(opts?.deviceIds ?? locations.map((item) => item.agentDeviceId));
  if (requested.length === 0) {
    return {
      ok: true,
      status: 200,
      models: localModels,
      locations,
      unreadDevices: [],
      ...(locations.length === 0 ? { catalogNote: REMOTE_UNAVAILABLE_NOTE } : {}),
    };
  }

  const remoteModels: AgentModel[] = [];
  const unreadDevices: UnreadDevice[] = [];
  let capabilityMissing = false;
  for (const id of requested) {
    if (capabilityMissing) {
      unreadDevices.push(unreadOf(id, locations));
      continue;
    }
    let res: { status: number; body?: unknown };
    try {
      res = await fetchJson("/agent-models?agent_device_id=" + encodeURIComponent(id));
    } catch {
      unreadDevices.push(unreadOf(id, locations));
      continue;
    }
    if (res.status === 400 || res.status === 404) {
      capabilityMissing = true;
      unreadDevices.push(unreadOf(id, locations));
      continue;
    }
    if (res.status !== 200) {
      unreadDevices.push(unreadOf(id, locations));
      continue;
    }
    const echoed = asRecord(res.body)?.agentDeviceId;
    if (echoed !== undefined && echoed !== id) {
      unreadDevices.push(unreadOf(id, locations));
      continue;
    }
    const name = deviceDisplayName(id, locations);
    for (const model of parseModels(res.body)) {
      remoteModels.push({ ...model, agentDeviceId: id, deviceName: name });
    }
  }

  if (capabilityMissing) {
    return {
      ok: true,
      status: 200,
      models: localModels,
      locations,
      unreadDevices,
      catalogNote: REMOTE_UNAVAILABLE_NOTE,
    };
  }
  return { ok: true, status: 200, models: [...localModels, ...remoteModels], locations, unreadDevices };
}
