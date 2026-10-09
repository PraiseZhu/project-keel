// SC-6: manual compliance. No frontmatter, only .md, ≤64KB each, every declared unit has
// MANUAL.md, every ghost_manual path referenced anywhere resolves, ported files carry the
// upstream provenance header.
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const dir = process.argv[2] ?? "plugin/manual";
const manifest = JSON.parse(readFileSync("plugin/ghost.json", "utf8"));
const errors = [];
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); const s = lstatSync(p); if (s.isSymbolicLink()) { errors.push(`symlink: ${p}`); return []; } return s.isDirectory() ? walk(p) : [p]; });
const files = walk(dir);
const SHA = "e43c7ee";

for (const f of files) {
  const rel = relative(dir, f);
  if (!f.endsWith(".md")) errors.push(`not .md: ${rel}`);
  const buf = readFileSync(f);
  if (buf.length > 64 * 1024) errors.push(`>64KB: ${rel} (${buf.length})`);
  const text = buf.toString("utf8");
  if (Buffer.from(text, "utf8").length !== buf.length) errors.push(`invalid utf-8: ${rel}`);
  if (text.startsWith("---\n")) errors.push(`frontmatter: ${rel}`);
  if (rel.startsWith("pstack/") && rel !== "pstack/MANUAL.md") {
    const first = text.split("\n", 1)[0];
    const upstreamPath = rel.slice("pstack/".length).replace(/(\.[a-z]+)\.md$/, "$1");
    if (!first.startsWith("> 移植自 pstack ") || !first.includes(upstreamPath) || !first.includes(SHA)) errors.push(`missing provenance header: ${rel}`);
  }
}
const keelManual = readFileSync(join(dir, "keel/MANUAL.md"), "utf8");
const keelBody = keelManual.replace(/^#.*\n+/, "");
const keelFirst = keelBody.split(/\n\n/)[0] ?? "";
if ([...keelFirst].length > 1500) errors.push(`keel MANUAL first paragraph ${[...keelFirst].length} > 1500 chars`);

const units = manifest.manual?.items ?? [];
if (units.length < 1 || units.length > 8) errors.push(`manual.items count ${units.length}`);
for (const u of units) if (!existsSync(join("plugin", u.dir, "MANUAL.md"))) errors.push(`unit ${u.name} lacks MANUAL.md`);
const byName = Object.fromEntries(units.map((u) => [u.name, u.dir]));

// Every ghost_manual path mentioned in the manual, the manifest or the source must resolve.
const refs = new Set();
const sources = [...files, "plugin/ghost.json", ...walk("src")];
for (const f of sources) {
  const t = readFileSync(f, "utf8");
  for (const m of t.matchAll(/ghost_manual\(\{\s*ghost_id:\s*\\?"keel\\?",\s*path:\s*\\?"([^"\\]+)\\?"/g)) refs.add(m[1]);
  for (const m of t.matchAll(/manual_path[^"]*"([a-z]+\/[^"$]+\.md)"/g)) refs.add(m[1]);
}
// Paths the tools build at runtime.
for (const pb of JSON.parse(readFileSync("tests/playbooks.json", "utf8"))) refs.add(`pstack/skills/poteto-mode/playbooks/${pb}.md`);
refs.add("pstack/skills/figure-it-out/SKILL.md");
let unresolved = 0;
for (const r of refs) {
  if (r.includes("<") || r.includes("{")) continue;
  const [unit, ...rest] = r.split("/");
  const d = byName[unit];
  if (!d || !existsSync(join("plugin", d, ...rest))) { errors.push(`unreachable ghost_manual path: ${r}`); unresolved++; }
}
if (errors.length) { for (const e of errors) console.log(`ERROR ${e}`); console.log(`MANUAL_FAIL ${errors.length}`); process.exit(1); }
console.log(`files=${files.length} refs=${refs.size}`);
console.log("MANUAL_OK");
