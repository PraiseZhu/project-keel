// ModelManual: the orchestrator's single source of model routes (stored in /kv).
// routing.json is not read here; it still feeds the manual `roles` tool.

export const MANUAL_VERSION = 1;
export const KV_MAX_BYTES = 64 * 1024;
export const MAX_FALLBACKS = 2;

export const HARNESSES = ["codex", "claude-code", "pi"] as const;
export type Harness = (typeof HARNESSES)[number];

export const TASK_TYPES = ["default", "bug-fix", "feature", "refactoring", "investigation", "pr"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const ROLES = ["explorer", "researcher", "worker", "verifier", "architect"] as const;
export type Role = (typeof ROLES)[number];

export const DIRECTION_GATES = ["lead", "astra"] as const;
export type DirectionGate = (typeof DIRECTION_GATES)[number];

export interface Route {
  readonly agent: Harness;
  readonly model: string;
  readonly provider_id: string;
  readonly effort?: string;
}

export interface Slot {
  readonly primary: Route;
  readonly fallbacks?: readonly Route[];
}

export type RoleSlots = { readonly [R in Role]?: Slot };
export type ProfileNodes = { readonly [T in TaskType]?: RoleSlots };

export interface Profile {
  readonly id: string;
  readonly name: string;
  readonly harness: Harness;
  readonly lead: Route;
  readonly direction_gate: DirectionGate;
  /** Optional astra-consult route. Omitted means fall back to the architect slot. */
  readonly direction_route?: Route;
  readonly inherit?: string;
  readonly nodes: ProfileNodes;
}

export type DefaultsByHarness = { readonly [H in Harness]?: string };

export interface ModelManual {
  readonly version: 1;
  readonly profiles: readonly Profile[];
  readonly defaults_by_harness: DefaultsByHarness;
}

/** One /agent-models item: model × agent × provider. */
export interface AgentModel {
  readonly id: string;
  readonly name?: string;
  readonly agent: string;
  readonly providerId: string;
  readonly providerName?: string;
  readonly efforts?: readonly string[] | null;
  readonly defaultEffort?: string | null;
  readonly visible?: boolean;
}

export class ManualError extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, message: string, path: string) {
    super(message);
    this.code = code;
    this.path = path;
  }
}

const luna = (effort: string): Slot => ({
  primary: { agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy", effort },
  fallbacks: [{ agent: "codex", model: "openai/gpt-6-luna", provider_id: "xd", effort }],
});

/** Appendix C default profiles. Art Cindy is primary; XD is fallback. */
export const DEFAULT_MANUAL: ModelManual = {
  version: 1,
  profiles: [
    {
      id: "sol",
      name: "Sol 主控",
      harness: "codex",
      lead: { agent: "codex", model: "gpt-6.1-sol", provider_id: "art-cindy", effort: "high" },
      direction_gate: "lead",
      nodes: {
        default: {
          explorer: luna("medium"),
          researcher: luna("high"),
          worker: {
            primary: { agent: "pi", model: "grok-4.6", provider_id: "art-cindy", effort: "high" },
            fallbacks: [{ agent: "pi", model: "x-ai-grok/grok-4.6", provider_id: "xd", effort: "high" }],
          },
          verifier: luna("high"),
          architect: {
            primary: { agent: "codex", model: "gpt-6-astra", provider_id: "art-cindy", effort: "xhigh" },
            fallbacks: [{ agent: "codex", model: "openai/gpt-6-astra", provider_id: "xd", effort: "xhigh" }],
          },
        },
      },
    },
    {
      id: "grok",
      name: "grok 主控",
      harness: "claude-code",
      lead: { agent: "claude-code", model: "grok-4.6", provider_id: "art-cindy", effort: "high" },
      direction_gate: "astra",
      direction_route: { agent: "claude-code", model: "anthropic/claude-opus-5-5", provider_id: "xd", effort: "xhigh" },
      nodes: {
        default: {
          explorer: { primary: { agent: "claude-code", model: "anthropic/claude-haiku-5-5", provider_id: "xd", effort: "medium" } },
          researcher: { primary: { agent: "claude-code", model: "anthropic/claude-haiku-5-5", provider_id: "xd", effort: "high" } },
          worker: { primary: { agent: "claude-code", model: "anthropic/claude-sonnet-5-5", provider_id: "xd", effort: "high" } },
          verifier: luna("high"),
          architect: { primary: { agent: "claude-code", model: "anthropic/claude-opus-5-5", provider_id: "xd", effort: "xhigh" } },
        },
      },
    },
  ],
  defaults_by_harness: { codex: "sol", "claude-code": "grok" },
};

export function cloneManual(manual: ModelManual): ModelManual {
  return JSON.parse(JSON.stringify(manual)) as ModelManual;
}

export function exportManual(manual: ModelManual): string {
  return JSON.stringify(manual);
}

export function importManual(json: string): ModelManual {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new ManualError("MANUAL_INVALID", "说明书不是合法 JSON。", "");
  }
  return parseManual(raw);
}

function isHarness(v: unknown): v is Harness {
  return typeof v === "string" && (HARNESSES as readonly string[]).includes(v);
}
function isTaskType(v: unknown): v is TaskType {
  return typeof v === "string" && (TASK_TYPES as readonly string[]).includes(v);
}
function isRole(v: unknown): v is Role {
  return typeof v === "string" && (ROLES as readonly string[]).includes(v);
}
function isDirectionGate(v: unknown): v is DirectionGate {
  return typeof v === "string" && (DIRECTION_GATES as readonly string[]).includes(v);
}

function parseRoute(raw: unknown, path: string): Route {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ManualError("MANUAL_INVALID", "路线必须是对象。", path);
  const o = raw as Record<string, unknown>;
  if (!isHarness(o.agent)) throw new ManualError("MANUAL_INVALID", "agent 必须是 codex、claude-code 或 pi。", `${path}/agent`);
  if (typeof o.model !== "string" || !o.model.trim()) throw new ManualError("MANUAL_INVALID", "model 不能为空。", `${path}/model`);
  if (typeof o.provider_id !== "string" || !o.provider_id.trim()) throw new ManualError("MANUAL_INVALID", "provider_id 不能为空。", `${path}/provider_id`);
  const route: Route = { agent: o.agent, model: o.model.trim(), provider_id: o.provider_id.trim() };
  if (o.effort !== undefined) {
    if (typeof o.effort !== "string" || !o.effort.trim()) throw new ManualError("MANUAL_INVALID", "effort 若填写必须是非空字符串。", `${path}/effort`);
    return { ...route, effort: o.effort.trim() };
  }
  return route;
}

function parseSlot(raw: unknown, path: string): Slot {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ManualError("MANUAL_INVALID", "节点格子必须是对象。", path);
  const o = raw as Record<string, unknown>;
  const primary = parseRoute(o.primary, `${path}/primary`);
  if (o.fallbacks === undefined) return { primary };
  if (!Array.isArray(o.fallbacks)) throw new ManualError("MANUAL_INVALID", "fallbacks 必须是数组。", `${path}/fallbacks`);
  if (o.fallbacks.length > MAX_FALLBACKS) throw new ManualError("MANUAL_INVALID", `备路线最多 ${MAX_FALLBACKS} 条。`, `${path}/fallbacks`);
  return { primary, fallbacks: o.fallbacks.map((f, i) => parseRoute(f, `${path}/fallbacks/${i}`)) };
}

function parseProfile(raw: unknown, path: string): Profile {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ManualError("MANUAL_INVALID", "主控方案必须是对象。", path);
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id.trim()) throw new ManualError("MANUAL_INVALID", "方案 id 不能为空。", `${path}/id`);
  if (typeof o.name !== "string" || !o.name.trim()) throw new ManualError("MANUAL_INVALID", "方案 name 不能为空。", `${path}/name`);
  if (!isHarness(o.harness)) throw new ManualError("MANUAL_INVALID", "harness 必须是 codex、claude-code 或 pi。", `${path}/harness`);
  if (!isDirectionGate(o.direction_gate)) throw new ManualError("MANUAL_INVALID", "direction_gate 必须是 lead 或 astra。", `${path}/direction_gate`);
  const lead = parseRoute(o.lead, `${path}/lead`);
  if (!o.nodes || typeof o.nodes !== "object" || Array.isArray(o.nodes)) throw new ManualError("MANUAL_INVALID", "nodes 必须是对象。", `${path}/nodes`);
  const nodes: { [T in TaskType]?: RoleSlots } = {};
  for (const [taskType, roles] of Object.entries(o.nodes as Record<string, unknown>)) {
    if (!isTaskType(taskType)) throw new ManualError("MANUAL_INVALID", `未知任务类型 ${taskType}。`, `${path}/nodes/${taskType}`);
    if (!roles || typeof roles !== "object" || Array.isArray(roles)) throw new ManualError("MANUAL_INVALID", "任务类型列必须是对象。", `${path}/nodes/${taskType}`);
    const col: { [R in Role]?: Slot } = {};
    for (const [role, slot] of Object.entries(roles as Record<string, unknown>)) {
      if (!isRole(role)) throw new ManualError("MANUAL_INVALID", `未知节点 ${role}。`, `${path}/nodes/${taskType}/${role}`);
      col[role] = parseSlot(slot, `${path}/nodes/${taskType}/${role}`);
    }
    nodes[taskType] = col;
  }
  const profile: Profile = { id: o.id.trim(), name: o.name.trim(), harness: o.harness, lead, direction_gate: o.direction_gate, nodes };
  const withDirection = o.direction_route !== undefined
    ? { ...profile, direction_route: parseRoute(o.direction_route, `${path}/direction_route`) }
    : profile;
  if (o.inherit !== undefined) {
    if (typeof o.inherit !== "string" || !o.inherit.trim()) throw new ManualError("MANUAL_INVALID", "inherit 若填写必须是方案 id。", `${path}/inherit`);
    return { ...withDirection, inherit: o.inherit.trim() };
  }
  return withDirection;
}

export function parseManual(raw: unknown): ModelManual {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ManualError("MANUAL_INVALID", "说明书必须是对象。", "");
  const o = raw as Record<string, unknown>;
  if (o.version !== MANUAL_VERSION) throw new ManualError("MANUAL_INVALID", `说明书 version 必须是 ${MANUAL_VERSION}。`, "version");
  if (!Array.isArray(o.profiles)) throw new ManualError("MANUAL_INVALID", "profiles 必须是数组。", "profiles");
  const profiles = o.profiles.map((p, i) => parseProfile(p, `profiles/${typeof (p as { id?: unknown })?.id === "string" ? (p as { id: string }).id : i}`));
  const seen = new Set<string>();
  for (const p of profiles) {
    if (seen.has(p.id)) throw new ManualError("MANUAL_INVALID", `方案 id 重复：${p.id}。`, `profiles/${p.id}`);
    seen.add(p.id);
  }
  if (!o.defaults_by_harness || typeof o.defaults_by_harness !== "object" || Array.isArray(o.defaults_by_harness)) {
    throw new ManualError("MANUAL_INVALID", "defaults_by_harness 必须是对象。", "defaults_by_harness");
  }
  const defaults: { [H in Harness]?: string } = {};
  for (const [h, id] of Object.entries(o.defaults_by_harness as Record<string, unknown>)) {
    if (!isHarness(h)) throw new ManualError("MANUAL_INVALID", `未知 harness ${h}。`, `defaults_by_harness/${h}`);
    if (typeof id !== "string" || !id.trim()) throw new ManualError("MANUAL_INVALID", "默认方案 id 不能为空。", `defaults_by_harness/${h}`);
    defaults[h] = id.trim();
  }
  return { version: 1, profiles, defaults_by_harness: defaults };
}
