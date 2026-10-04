// Standalone check-plan CLI shipped as plugin/node/check-plan.mjs: same output and exit
// code as upstream `check-plan.mjs <plan.md>`.
import { readFileSync } from "node:fs";
import { checkPlan } from "../plan/check-plan.ts";

const file = process.argv[2];
if (!file) {
  process.stderr.write("usage: node check-plan.mjs <plan.md>\n");
  process.exitCode = 2;
} else {
  const r = checkPlan(readFileSync(file, "utf8"), file);
  for (const line of r.report) process.stdout.write(line + "\n");
  for (const p of r.problems) process.stderr.write(p + "\n");
  process.exitCode = r.ok ? 0 : 1;
}
