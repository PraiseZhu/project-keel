// GraphSpec: the compiled, machine-executable form of a pstack playbook.
// This module is data + validation only; it does not interpret or dispatch.

export const NODE_KINDS = ["dispatch", "plugin_task", "tool", "gate", "human"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const NODE_ROLES = ["explorer", "researcher", "worker", "verifier", "architect"] as const;
export type NodeRole = (typeof NODE_ROLES)[number];

export const EDGE_ONS = ["ok", "fail", "fingerprint_repeat", "head_moved", "ci_red", "threads", "conflict"] as const;
export type EdgeOnLiteral = (typeof EDGE_ONS)[number];
export type EdgeOn = EdgeOnLiteral | `gate:${string}`;

export const EXIT_IDS = ["done", "stopped"] as const;
export type ExitId = (typeof EXIT_IDS)[number];

export const ADAPTATION_KINDS = ["equivalent_handoff", "user_goal_override", "not_applicable"] as const;
export type AdaptationKind = (typeof ADAPTATION_KINDS)[number];

export type NodeWhen =
  | { kind: "always" }
  | { kind: "crosses_function_boundary" }
  | { kind: "fingerprint_repeat"; times: 2 }
  | { kind: "design_contested" };

export interface GraphNode {
  id: string;
  kind: NodeKind;
  role?: NodeRole;
  writes: boolean;
  playbook_steps: string[];
  timebox_min: number;
  max_attempts: number;
  when?: NodeWhen;
}

export interface GraphEdge {
  from: string;
  to: string;
  on: EdgeOn;
}

export interface Adaptation {
  /** Numbered step id (`bug-fix#3`) or a whole playbook id when the source has no numbered steps. */
  playbook_step: string;
  kind: AdaptationKind;
  reason: string;
}

export interface GraphSpec {
  id: string;
  version: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  entry: string;
  exits: ExitId[];
  /** Playbook ids this graph is responsible for mapping. */
  covers: readonly string[];
  adaptations: Adaptation[];
}

export interface GraphIssue {
  graph: string;
  rule: string;
  message: string;
}

const KIND_SET = new Set<string>(NODE_KINDS);
const ROLE_SET = new Set<string>(NODE_ROLES);
const EDGE_ON_SET = new Set<string>(EDGE_ONS);
const EXIT_SET = new Set<string>(EXIT_IDS);
const ADAPT_SET = new Set<string>(ADAPTATION_KINDS);

/** Numbered steps from a playbook body. Uses the same `---` split as `scripts/build.mjs`. */
export function parseNumberedSteps(playbookId: string, markdown: string): string[] {
  const body = markdown.includes("\n---\n") ? markdown.split("\n---\n").at(-1)! : markdown;
  const steps: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(/^(\d+)\. /gm)) {
    const id = `${playbookId}#${match[1]}`;
    if (seen.has(id)) continue;
    seen.add(id);
    steps.push(id);
  }
  return steps;
}

export function expectedStepsFor(spec: GraphSpec, playbooks: Readonly<Record<string, string>>): { steps: string[]; issues: GraphIssue[] } {
  const issues: GraphIssue[] = [];
  const steps: string[] = [];
  for (const id of spec.covers) {
    const text = playbooks[id];
    if (text === undefined) {
      issues.push({ graph: spec.id, rule: "missing_playbook_text", message: `covers 含 ${id}，但没有提供该 playbook 原文` });
      continue;
    }
    steps.push(...parseNumberedSteps(id, text));
  }
  return { steps, issues };
}

function issue(graph: string, rule: string, message: string): GraphIssue {
  return { graph, rule, message };
}

function isEdgeOn(on: string): on is EdgeOn {
  if (EDGE_ON_SET.has(on)) return true;
  return on.startsWith("gate:") && on.length > "gate:".length;
}

/** Strongly connected components with more than one node, or a self-loop. */
function cyclesOf(ids: readonly string[], edges: readonly GraphEdge[]): string[][] {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const sccs: string[][] = [];
  let seq = 0;
  const adj = new Map<string, string[]>();
  for (const id of ids) adj.set(id, []);
  for (const e of edges) adj.get(e.from)?.push(e.to);

  const strongconnect = (v: string) => {
    index.set(v, seq);
    lowlink.set(v, seq);
    seq += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!index.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }
    if (lowlink.get(v) === index.get(v)) {
      const scc: string[] = [];
      while (stack.length) {
        const w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
        if (w === v) break;
      }
      const selfLoop = (adj.get(v) ?? []).includes(v);
      if (scc.length > 1 || selfLoop) sccs.push(scc);
    }
  };

  for (const id of ids) if (!index.has(id)) strongconnect(id);
  return sccs;
}

function reachableFrom(entry: string, edges: readonly GraphEdge[]): Set<string> {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const list = adj.get(e.from);
    if (list) list.push(e.to);
    else adj.set(e.from, [e.to]);
  }
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const n of adj.get(cur) ?? []) queue.push(n);
  }
  return seen;
}

/**
 * Validate a compiled graph. Pass `expectedSteps` (from `parseNumberedSteps` on
 * playbook files) so numbered-step coverage is checked; omit it to skip that rule.
 */
export function validateGraph(spec: GraphSpec, expectedSteps: readonly string[] = []): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const g = spec.id || "(missing-id)";

  if (!spec.id) issues.push(issue(g, "id", "GraphSpec.id 不能为空"));
  if (spec.version !== 1) issues.push(issue(g, "version", `version 须为 1，实际 ${spec.version}`));

  const extraExits = spec.exits.filter((x) => !EXIT_SET.has(x));
  if (extraExits.length) issues.push(issue(g, "exits", `exits 只能是 done / stopped，发现 ${extraExits.join("、")}`));
  for (const need of EXIT_IDS) {
    if (!spec.exits.includes(need)) issues.push(issue(g, "exits", `exits 缺少 ${need}`));
  }

  const byId = new Map<string, GraphNode>();
  for (const node of spec.nodes) {
    if (byId.has(node.id)) issues.push(issue(g, "duplicate_node", `重复节点 id ${node.id}`));
    byId.set(node.id, node);
    if (!KIND_SET.has(node.kind)) issues.push(issue(g, "node_kind", `节点 ${node.id} kind=${node.kind} 不合法`));
    if (node.role !== undefined && !ROLE_SET.has(node.role)) issues.push(issue(g, "node_role", `节点 ${node.id} role=${node.role} 不合法`));
    if (node.role === "architect" && node.kind !== "dispatch") {
      issues.push(issue(g, "node_role", `节点 ${node.id} 是 architect 但 kind 不是 dispatch`));
    }
    if (!Number.isFinite(node.timebox_min) || node.timebox_min < 0) {
      issues.push(issue(g, "timebox", `节点 ${node.id} timebox_min 不合法`));
    }
    if (!Number.isFinite(node.max_attempts) || node.max_attempts < 1) {
      issues.push(issue(g, "max_attempts", `节点 ${node.id} max_attempts 须 ≥ 1，实际 ${node.max_attempts}`));
    }
    if (!Array.isArray(node.playbook_steps)) {
      issues.push(issue(g, "playbook_steps", `节点 ${node.id} playbook_steps 必须是数组`));
    }
  }

  for (const exit of spec.exits) {
    if (!byId.has(exit)) issues.push(issue(g, "exits", `exit 节点 ${exit} 不存在`));
  }
  if (!byId.has(spec.entry)) issues.push(issue(g, "entry", `entry ${spec.entry} 不存在`));

  for (const edge of spec.edges) {
    if (!byId.has(edge.from)) issues.push(issue(g, "edge_endpoint", `边 from=${edge.from} 节点不存在`));
    if (!byId.has(edge.to)) issues.push(issue(g, "edge_endpoint", `边 to=${edge.to} 节点不存在`));
    if (!isEdgeOn(edge.on)) issues.push(issue(g, "edge_on", `边 ${edge.from}→${edge.to} on=${edge.on} 不合法`));
  }

  if (byId.has(spec.entry)) {
    const reach = reachableFrom(spec.entry, spec.edges);
    for (const node of spec.nodes) {
      if (!reach.has(node.id)) issues.push(issue(g, "unreachable", `节点 ${node.id} 从 entry 不可达`));
    }
  }

  const cycles = cyclesOf([...byId.keys()], spec.edges);
  for (const cycle of cycles) {
    const inCycle = new Set(cycle);
    const hasExit = spec.edges.some((e) => inCycle.has(e.from) && !inCycle.has(e.to));
    if (!hasExit) issues.push(issue(g, "loop_exit", `循环 ${cycle.join("→")} 没有退出边`));
    for (const id of cycle) {
      const node = byId.get(id);
      if (node && node.max_attempts < 1) {
        issues.push(issue(g, "loop_max_attempts", `循环内节点 ${id} 缺少有效 max_attempts`));
      }
    }
  }

  for (const a of spec.adaptations) {
    if (!ADAPT_SET.has(a.kind)) issues.push(issue(g, "adaptation_kind", `adaptation ${a.playbook_step} kind=${a.kind} 不合法`));
    if (!a.playbook_step) issues.push(issue(g, "adaptation_step", "adaptation 缺少 playbook_step"));
    if (!a.reason) issues.push(issue(g, "adaptation_reason", `adaptation ${a.playbook_step} 缺少原因`));
  }

  const mapped = new Set(spec.nodes.flatMap((n) => n.playbook_steps));
  const adapted = new Set(spec.adaptations.map((a) => a.playbook_step));
  for (const step of expectedSteps) {
    if (!mapped.has(step) && !adapted.has(step)) {
      issues.push(issue(g, "unmapped_step", `${step} 既未映射到任何节点的 playbook_steps，也不在 adaptations`));
    }
  }

  if (spec.id === "investigation") {
    for (const node of spec.nodes) {
      if (node.writes) issues.push(issue(g, "investigation_writes", `investigation 节点 ${node.id} writes=true`));
      if (node.role === "architect") issues.push(issue(g, "investigation_architect", `investigation 节点 ${node.id} 是 architect`));
    }
    const forbidden = ["open-pr", "wait-ci", "ci-rerun-once", "astra-final-review", "verify-head", "report-ready"];
    for (const id of forbidden) {
      if (byId.has(id)) issues.push(issue(g, "investigation_pr_tail", `investigation 不应含 PR 尾段节点 ${id}`));
    }
  }

  return issues;
}

export function formatIssues(issues: readonly GraphIssue[]): string {
  return issues.map((i) => `graph=${i.graph} rule=${i.rule} ${i.message}`).join("\n");
}
