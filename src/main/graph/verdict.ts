// Map a NodeReport + actual evidence onto an orch ledger verdict. PASS wording never upgrades the level.

import { family } from "../../shared/fanout.ts";
import type { Verdict } from "../../node/orch/store.ts";

export type OrchLevel = Verdict;
export type NodeVerdict = "PASS" | "PASS+NOTES" | "FAIL";
export type EvidenceSurface = "live-ui" | "unit-test" | "type-check" | "blocked";

export interface NodeReport {
  readonly dispatch_key?: string;
  readonly status?: "done" | "partial" | "blocked" | "failed";
  readonly summary?: string;
  readonly verdict?: NodeVerdict;
  readonly ran?: readonly { readonly cmd: string; readonly exit_code: number }[];
  readonly findings?: readonly string[];
  readonly surface?: EvidenceSurface;
}

export interface RouteIdentity {
  readonly agent: string;
  readonly model: string;
  readonly provider_id: string;
  readonly effort?: string;
}

export interface GraphVerdict {
  readonly repo: string;
  readonly pr: number | string;
  readonly base_ref: string;
  readonly base_sha: string;
  readonly head_sha: string;
  readonly patch_id: string;
  readonly level: OrchLevel;
  readonly surface: EvidenceSurface | "failed" | "blocked";
  readonly by_route: RouteIdentity;
  readonly by_family: string;
}

const LEVEL_RANK: Record<OrchLevel, number> = {
  "live-ui-verified": 3,
  "unit-test-verified": 2,
  "type-check-only": 1,
  "verifier-blocked": 0,
  "verifier-failed": 0,
};

export function levelMeets(actual: OrchLevel, required: OrchLevel = "unit-test-verified"): boolean {
  return LEVEL_RANK[actual] > 0 && LEVEL_RANK[actual] >= LEVEL_RANK[required];
}

function inferSurface(ran: readonly { cmd: string; exit_code: number }[]): EvidenceSurface {
  const passed = ran.filter((r) => r.exit_code === 0).map((r) => r.cmd.toLowerCase());
  if (passed.some((c) => /playwright|cypress|selenium|\be2e\b|live-ui|ui-test/.test(c))) return "live-ui";
  if (passed.some((c) => /vitest|pytest|jest|npm test|pnpm test|cargo test|go test|node --test/.test(c))) return "unit-test";
  return "type-check";
}

function blocked(report: NodeReport): boolean {
  if (report.status === "blocked" || report.surface === "blocked") return true;
  return (report.findings ?? []).some((f) => /无法验证|环境.*(不能|无法)|verifier-blocked|cannot verify/i.test(f));
}

/** PASS / PASS+NOTES / FAIL → orch level. The word PASS does not raise the level. */
export function mapOrchLevel(report: NodeReport): OrchLevel {
  if (report.verdict === "FAIL" || report.status === "failed") return "verifier-failed";
  if (blocked(report)) return "verifier-blocked";
  const surface = report.surface ?? inferSurface(report.ran ?? []);
  if (surface === "live-ui") return "live-ui-verified";
  if (surface === "unit-test") return "unit-test-verified";
  return "type-check-only";
}

export function buildVerdict(input: {
  readonly repo: string;
  readonly pr: number | string;
  readonly base_ref: string;
  readonly base_sha: string;
  readonly head_sha: string;
  readonly patch_id: string;
  readonly report: NodeReport;
  readonly route: RouteIdentity;
}): GraphVerdict {
  const level = mapOrchLevel(input.report);
  const surface: GraphVerdict["surface"] =
    level === "verifier-failed" ? "failed" : level === "verifier-blocked" ? "blocked" : (input.report.surface ?? inferSurface(input.report.ran ?? []));
  return {
    repo: input.repo,
    pr: input.pr,
    base_ref: input.base_ref,
    base_sha: input.base_sha,
    head_sha: input.head_sha,
    patch_id: input.patch_id,
    level,
    surface,
    by_route: input.route,
    by_family: family(input.route.model),
  };
}
