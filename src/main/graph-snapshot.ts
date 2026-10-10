// Read-only load of runs/*/graph-state.json from the plugin data dir.

import type { Host } from "./host.ts";
import type { GraphState } from "../panel/graph-model.ts";

/** Old create-on-write leftovers: only run_id / status / nudge_* fields, never nodes, spec_id, or goal. */
export function isPlaceholderRun(r: { nodes?: unknown; spec_id?: unknown; goal?: unknown }): boolean {
  const nodes = r.nodes;
  const nodesMissing = !nodes || typeof nodes !== "object" || Array.isArray(nodes);
  const noSpec = r.spec_id == null || r.spec_id === "";
  const noGoal = typeof r.goal !== "string";
  return nodesMissing && noSpec && noGoal;
}

export async function loadGraphStates(host: Host): Promise<GraphState[]> {
  const list = await host.fs({ op: "list", root: "data", path: "runs" });
  const names = (list.ok ? list.entries ?? [] : []).map((e) => e.name).filter((n) => Boolean(n) && !n.includes("/") && n !== "." && n !== "..");
  const runs: GraphState[] = [];
  for (const name of names.sort()) {
    const r = await host.fs({ op: "read", root: "data", path: `runs/${name}/graph-state.json` });
    if (!r.ok || !r.content) continue;
    try {
      const parsed = JSON.parse(r.content) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) runs.push(parsed as GraphState);
    } catch {
      /* skip broken snapshots */
    }
  }
  return runs;
}
