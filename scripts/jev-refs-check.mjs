// SC-16: no non-archive reference to typesafe-jev remains in the listed rule files and repos.
import { existsSync, readFileSync } from "node:fs";
import { countOld, loadRefs } from "./jev-refs.mjs";

const { targets, checkOnly } = loadRefs();
let left = 0;
for (const f of [...targets, ...checkOnly]) {
  if (!existsSync(f)) continue;
  const n = countOld(readFileSync(f, "utf8"));
  if (n) { left += n; console.log(`OLD_REF ${n} ${f.replace(process.env.HOME, "~")}`); }
}
console.log(left ? `JEV_REFS_REMAINING ${left}` : "JEV_REFS_MIGRATED");
process.exit(left ? 1 : 0);
