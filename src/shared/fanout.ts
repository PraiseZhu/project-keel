// Pure fanout planning: which routing.json tier each lane uses, lane labels, and the
// create_workers payload. Node reads routing.json and calls this; tests call it directly.

import type { RouteWithFallbacks } from "./types.ts";

export type FanoutKind = "arena" | "interrogate" | "swarm";

export interface Tiers {
  readonly review: RouteWithFallbacks;
  readonly execute: RouteWithFallbacks;
  /** A review variant (top-level or another lead's override) from a third model family, if any. */
  readonly reviewAlt: RouteWithFallbacks | null;
  readonly e2e: RouteWithFallbacks | null;
}

export interface LanePlan {
  readonly label: string;
  readonly role: "developer" | "reviewer" | "tester";
  readonly lane: "candidate" | "cross-judge" | "reviewer" | "slice" | "verifier";
  readonly write: boolean;
  readonly route: RouteWithFallbacks;
  readonly note?: string;
  readonly slice?: string;
}

export function family(model: string): string {
  return model.replace(/^[^/]+\//, "").split(/[-.\d]/)[0]!.toLowerCase();
}

/** Three seats from three tiers so the lanes span different model families. */
export function seats(t: Tiers): { route: RouteWithFallbacks; note?: string }[] {
  if (t.reviewAlt) return [{ route: t.review }, { route: t.execute }, { route: t.reviewAlt }];
  return [{ route: t.review }, { route: t.execute }, { route: t.review, note: "routing.json 没有第三家族的审核档，C 席与 A 席同模型" }];
}

export function planLanes(kind: FanoutKind, t: Tiers, opts: { lanes?: number; slices?: readonly string[]; leadModel?: string | null }): LanePlan[] {
  const lead = opts.leadModel ?? null;
  if (kind === "swarm") {
    const slices = opts.slices?.length ? opts.slices : ["main"];
    const out: LanePlan[] = slices.slice(0, 8).map((s, i) => ({ label: `s${i + 1}`, role: "developer", lane: "slice", write: true, route: t.execute, slice: s }));
    if (t.e2e) out.push({ label: "verify", role: "tester", lane: "verifier", write: false, route: t.e2e });
    return out;
  }
  const n = Math.min(3, Math.max(2, opts.lanes ?? 3));
  const s = seats(t).slice(0, n);
  if (kind === "interrogate") return s.map((x, i) => ({ label: `r${i + 1}`, role: "reviewer", lane: "reviewer", write: false, route: x.route, ...(x.note ? { note: x.note } : {}) }));
  const out: LanePlan[] = s.map((x, i) => ({ label: `c${i + 1}`, role: "developer", lane: "candidate", write: true, route: x.route, ...(x.note ? { note: x.note } : {}) }));
  const leadFam = lead ? family(lead) : null;
  const judge = [t.review, t.execute, t.reviewAlt].filter((r): r is RouteWithFallbacks => r !== null).find((r) => family(r.model) !== leadFam) ?? t.review;
  out.push({ label: "judge", role: "reviewer", lane: "cross-judge", write: false, route: judge, note: "与 lead 不同家族" });
  return out;
}

export function workerLabel(fanoutId: string, label: string): string {
  return `${fanoutId.slice(-8)}-${label}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 32);
}
