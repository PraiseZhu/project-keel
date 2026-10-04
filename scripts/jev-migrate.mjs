// Step 12 migration: typesafe-jev/evaluate → keel/jev in the listed files.
//   --dry-run (default)  write a unified diff to _tmp/jev-migration.diff, change nothing
//   --apply              rewrite the files (only after Keel is installed and jev works on all three machines)
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRefs, migrateText } from "./jev-refs.mjs";

const apply = process.argv.includes("--apply");
const { targets, checkOnly } = loadRefs();
mkdirSync("_tmp/jev-migration", { recursive: true });
let diff = "";
let changed = 0;
for (const f of targets) {
  const before = readFileSync(f, "utf8");
  const after = migrateText(before);
  if (after === before) continue;
  changed++;
  const tmp = join("_tmp/jev-migration", `${changed}.after`);
  writeFileSync(tmp, after);
  try {
    execFileSync("git", ["diff", "--no-index", "--no-color", f, tmp], { encoding: "utf8" });
  } catch (e) {
    diff += e.stdout;
  }
  if (apply) writeFileSync(f, after);
}
writeFileSync("_tmp/jev-migration.diff", diff);
console.log(`${apply ? "APPLIED" : "DRY_RUN"} files=${changed} diff=_tmp/jev-migration.diff`);
for (const c of checkOnly) console.log(`CHECK_ONLY (Cindy-managed copy, update at source): ${c.replace(process.env.HOME, "~")}`);
