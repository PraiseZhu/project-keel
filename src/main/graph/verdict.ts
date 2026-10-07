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
  /** Self-reported surface. It can lower the level but never raise it above the evidence. */
  readonly surface?: EvidenceSurface;
  /** Live-UI artifacts (screenshot paths, step logs). live-ui-verified needs at least one. */
  readonly ui_evidence?: readonly string[];
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

type Ran = readonly { readonly cmd: string; readonly exit_code: number }[];

const INFO_ONLY = new Set(["--version", "--help", "--list", "--listtests", "--collect-only", "--showconfig"]);
const PM = new Set(["npm", "pnpm", "yarn", "bun"]);
const RUNNERS = new Set(["vitest", "jest", "mocha", "pytest"]);

type TestKind = "unit" | "ui";

/** Classify one simple command by its executable, not by words anywhere in the text. */
function classifySimple(tokens: string[]): TestKind | null {
  let t = tokens.filter(Boolean);
  while (t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0]!)) t = t.slice(1);
  if (t[0] === "env") return classifySimple(t.slice(1));
  if (!t.length) return null;
  const exe = t[0]!.split("/").pop()!.toLowerCase();
  const rest = t.slice(1);
  const args = rest.map((a) => a.toLowerCase());
  if (args.some((a) => INFO_ONLY.has(a))) return null;
  if (exe === "npx" || exe === "bunx") return classifySimple(rest.filter((a, i) => !(i === 0 && a.startsWith("-"))));
  if (exe === "uv" && args[0] === "run") return classifySimple(rest.slice(1));
  if (PM.has(exe) && (args[0] === "exec" || args[0] === "dlx")) return classifySimple(rest.slice(1));
  if (RUNNERS.has(exe)) return "unit";
  if ((exe === "python" || exe === "python3") && args[0] === "-m" && args[1] === "pytest") return "unit";
  if ((exe === "go" || exe === "cargo") && args[0] === "test") return "unit";
  if (exe === "node" && args[0] === "--test") return "unit";
  if (exe === "playwright" && args[0] === "test") return "ui";
  if (exe === "cypress" && args[0] === "run") return "ui";
  if (PM.has(exe)) {
    const script = args[0] === "run" ? args[1] : args[0];
    if (script && /^test(:[\w-]+)?$/.test(script)) return "unit";
  }
  return null;
}

/**
 * A command proves a test run only when a test runner is the executable of a segment and
 * the exit code covers it: pipes, `||` and `;` let a failing test still exit 0, so they prove nothing.
 */
function testInvocation(cmd: string): TestKind | null {
  if (/\|\||\||;|`|\$\(/.test(cmd)) return null;
  let kind: TestKind | null = null;
  for (const seg of cmd.split("&&")) {
    const k = classifySimple(seg.trim().split(/\s+/));
    if (k === "ui" || (k === "unit" && kind === null)) kind = k;
  }
  return kind;
}

function isRealTest(cmd: string): boolean {
  return testInvocation(cmd) !== null;
}

/** Highest surface the passing commands and artifacts actually prove. */
function evidenceSurface(report: NodeReport): EvidenceSurface {
  const ran: Ran = report.ran ?? [];
  if (ran.some((r) => r.exit_code !== 0 && isRealTest(r.cmd))) return "type-check";
  const tests = ran.filter((r) => r.exit_code === 0).map((r) => testInvocation(r.cmd)).filter((k): k is TestKind => k !== null);
  const ui = (report.ui_evidence ?? []).some((e) => e.trim().length > 0);
  if (ui && (report.surface === "live-ui" || tests.includes("ui"))) return "live-ui";
  if (tests.length) return "unit-test";
  return "type-check";
}

const SURFACE_RANK: Record<Exclude<EvidenceSurface, "blocked">, number> = { "live-ui": 3, "unit-test": 2, "type-check": 1 };

function effectiveSurface(report: NodeReport): EvidenceSurface {
  const proven = evidenceSurface(report);
  const claimed = report.surface;
  if (!claimed || claimed === "blocked" || proven === "blocked") return proven;
  return SURFACE_RANK[claimed] < SURFACE_RANK[proven] ? claimed : proven;
}

function blocked(report: NodeReport): boolean {
  if (report.status === "blocked" || report.surface === "blocked") return true;
  return (report.findings ?? []).some((f) => /无法验证|环境.*(不能|无法)|verifier-blocked|cannot verify/i.test(f));
}

/** PASS / PASS+NOTES / FAIL → orch level. Neither the word PASS nor a self-reported surface raises the level. */
export function mapOrchLevel(report: NodeReport): OrchLevel {
  if (report.verdict === "FAIL" || report.status === "failed") return "verifier-failed";
  if (blocked(report)) return "verifier-blocked";
  // A failing test run is a failure whatever the verdict word or self-reported surface says.
  if ((report.ran ?? []).some((r) => r.exit_code !== 0 && isRealTest(r.cmd))) return "verifier-failed";
  const surface = effectiveSurface(report);
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
    level === "verifier-failed" ? "failed" : level === "verifier-blocked" ? "blocked" : effectiveSurface(input.report);
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
