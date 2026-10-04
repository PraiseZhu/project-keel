// SC-2: every upstream watch-pr test case must exist and pass in the ported suite.
//   --snapshot <upstream watch-pr dir>   regenerate tests/upstream-cases.json from upstream
//   --ported <vitest json report>        compare against the committed snapshot
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const snapPath = join(process.cwd(), "tests/upstream-cases.json");

function titles(src) {
  const out = [];
  const stack = [];
  // Track describe nesting by indentation of `describe(` lines; good enough for upstream style.
  for (const line of src.split("\n")) {
    const d = line.match(/^(\s*)describe\(\s*(["'`])(.+?)\2/);
    if (d) { while (stack.length && stack.at(-1).indent >= d[1].length) stack.pop(); stack.push({ indent: d[1].length, name: d[3] }); continue; }
    const t = line.match(/^(\s*)(?:it|test)\(\s*(["'`])(.+?)\2/);
    if (t) { while (stack.length && stack.at(-1).indent >= t[1].length) stack.pop(); out.push([...stack.map((s) => s.name), t[3]].join(" > ")); }
  }
  return out;
}

if (opt("--snapshot")) {
  const dir = opt("--snapshot");
  const files = readdirSync(dir).filter((f) => f.endsWith(".test.ts")).sort();
  const snap = { upstream: "cursor/plugins pstack/skills/poteto-mode/scripts/watch-pr", sha: opt("--sha") ?? "e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a", files: Object.fromEntries(files.map((f) => [f, titles(readFileSync(join(dir, f), "utf8"))])) };
  writeFileSync(snapPath, JSON.stringify(snap, null, 2) + "\n");
  console.log(`snapshot: ${Object.values(snap.files).flat().length} cases from ${files.length} files`);
  process.exit(0);
}

const report = JSON.parse(readFileSync(opt("--ported"), "utf8"));
const snap = JSON.parse(readFileSync(snapPath, "utf8"));
const passed = new Set();
for (const f of report.testResults) for (const a of f.assertionResults) if (a.status === "passed") passed.add([...a.ancestorTitles, a.title].join(" > "));
const expected = Object.values(snap.files).flat();
const missing = expected.filter((t) => ![...passed].some((p) => p === t || p.startsWith(t)));
console.log(`upstream cases: ${expected.length}; ported passing: ${passed.size}; missing: ${missing.length}`);
for (const m of missing) console.log(`  MISSING ${m}`);
console.log(`UPSTREAM_CASES_COVERED=${missing.length === 0 && passed.size >= expected.length}`);
process.exit(missing.length ? 1 : 0);
