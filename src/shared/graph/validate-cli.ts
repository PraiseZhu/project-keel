// Node-only build-time check: compile pstack graphs and fail the bundle if any is illegal.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { allGraphs } from "./pstack.ts";
import { expectedStepsFor, formatIssues, validateGraph, type GraphIssue } from "./spec.ts";

const PLAYBOOKS = ["bug-fix", "feature", "refactoring", "investigation", "opening-a-pr", "babysit", "shipping", "autonomous-run"] as const;
const pbDir = join(process.cwd(), "plugin/manual/pstack/skills/poteto-mode/playbooks");

function loadPlaybooks(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of PLAYBOOKS) {
    const path = join(pbDir, `${id}.md`);
    if (!existsSync(path)) throw new Error(`缺少 playbook 原文：${path}`);
    out[id] = readFileSync(path, "utf8");
  }
  return out;
}

const playbooks = loadPlaybooks();
const issues: GraphIssue[] = [];
for (const spec of allGraphs()) {
  const expected = expectedStepsFor(spec, playbooks);
  issues.push(...expected.issues);
  issues.push(...validateGraph(spec, expected.steps));
}

if (issues.length) {
  console.error(`GRAPH_INVALID ${issues.length}`);
  console.error(formatIssues(issues));
  process.exit(1);
}
console.log(`GRAPH_OK graphs=${allGraphs().map((g) => g.id).join(",")}`);
