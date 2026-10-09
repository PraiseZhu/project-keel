// Coverage check against docs/coverage-map.md (129 upstream items).
//   --phase P1|P2|P3|all                 check every item of that phase has an existing target
//   --init <source coverage-map.md>      (re)write docs/coverage-map.md with concrete Keel paths
//   --upstream <dir> [--sha <sha>]       report upstream files added/removed vs the map
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const MAP = "docs/coverage-map.md";

const SCRIPT_TARGETS = {
  "skills/poteto-mode/scripts/check-plan.mjs": ["src/node/plan/check-plan.ts"],
  "skills/poteto-mode/scripts/orch/orch.test.ts": ["tests/orch.test.ts"],
  "skills/poteto-mode/scripts/orch/orch.ts": ["src/node/orch/cli.ts", "src/node/orch/rpc.ts"],
  "skills/poteto-mode/scripts/orch/store.ts": ["src/node/orch/store.ts"],
  "skills/poteto-mode/scripts/watch-pr/cli.test.ts": ["tests/pr-rpc.test.ts"],
  "skills/poteto-mode/scripts/watch-pr/cli.ts": ["src/node/pr/upstream/cli.ts", "src/node/rpc.ts"],
  "skills/poteto-mode/scripts/watch-pr/fakes.test-helper.ts": ["tests/helpers/upstream-fakes.ts"],
  "skills/poteto-mode/scripts/watch-pr/github.test.ts": ["tests/github.test.ts"],
  "skills/poteto-mode/scripts/watch-pr/github.ts": ["src/node/pr/upstream/github.ts", "src/node/env.ts"],
  "skills/poteto-mode/scripts/watch-pr/policy.test.ts": ["tests/policy.test.ts"],
  "skills/poteto-mode/scripts/watch-pr/policy.ts": ["src/node/pr/upstream/policy.ts", "src/shared/lanes.ts"],
  "skills/poteto-mode/scripts/watch-pr/render.ts": ["src/node/pr/upstream/render.ts", "src/node/pr/snapshot.ts"],
  "skills/poteto-mode/scripts/watch-pr/types.compile.ts": ["src/node/pr/upstream/types.compile.ts"],
  "skills/poteto-mode/scripts/watch-pr/types.ts": ["src/node/pr/upstream/types.ts"],
  "skills/poteto-mode/scripts/worktree-audit.sh": ["src/node/git/worktree.ts"],
  "skills/show-me-your-work/scripts/log.sh": ["src/main/ledger.ts", "src/main/tools/pstack.ts"],
};
const EXTRA = {
  "agents/comment-sicko.md": ["plugin/manual/keel/fanout/lanes/comment-sicko.md"],
  "agents/poteto-agent.md": ["plugin/manual/keel/fanout/lanes/owner.md"],
  "skills/poteto-mode/SKILL.md": ["src/main/tools/pstack.ts"],
  "skills/arena/SKILL.md": ["src/main/fanout/tools.ts"],
  "skills/interrogate/SKILL.md": ["src/main/fanout/tools.ts"],
  "skills/swarm/SKILL.md": ["src/main/fanout/tools.ts"],
  "skills/setup-pstack/SKILL.md": ["src/node/routes/routing.ts"],
  "skills/show-me-your-work/SKILL.md": ["src/main/ledger.ts"],
  "skills/poteto-mode/playbooks/autonomous-run.md": ["src/shared/graph/pstack.ts"],
  "skills/poteto-mode/playbooks/babysit.md": ["src/main/tools/pr.ts", "src/shared/graph/pstack.ts"],
  "skills/poteto-mode/playbooks/bug-fix.md": ["src/shared/graph/pstack.ts"],
  "skills/poteto-mode/playbooks/feature.md": ["src/shared/graph/pstack.ts"],
  "skills/poteto-mode/playbooks/investigation.md": ["src/shared/graph/pstack.ts"],
  "skills/poteto-mode/playbooks/opening-a-pr.md": ["src/shared/graph/pstack.ts"],
  "skills/poteto-mode/playbooks/refactoring.md": ["src/shared/graph/pstack.ts"],
  "skills/poteto-mode/playbooks/shipping.md": ["src/shared/graph/pstack.ts"],
  "skills/poteto-mode/playbooks/worktree-cleanup.md": ["src/node/git/worktree.ts"],
  "skills/poteto-mode/playbooks/multi-phase-plan.md": ["src/node/plan/check-plan.ts"],
  "skills/poteto-mode/playbooks/orchestrate.md": ["src/node/orch/store.ts"],
};

function targetsFor(path, method) {
  if (method === "E") return [];
  if (SCRIPT_TARGETS[path]) return SCRIPT_TARGETS[path];
  const mirror = `plugin/manual/pstack/${extname(path) === ".md" ? path : path + ".md"}`;
  return [mirror, ...(EXTRA[path] ?? [])];
}

function parse(text) {
  return text.split("\n").filter((l) => /^\| (skill|playbook|agent|script|reference|automation) \| `/.test(l)).map((l) => {
    const c = l.split("|").slice(1, -1).map((x) => x.trim());
    return { type: c[0], path: c[1].replace(/`/g, ""), method: c[2], target: c[3], phase: c[4], note: c[5] ?? "" };
  });
}

if (opt("--init")) {
  const src = readFileSync(opt("--init"), "utf8");
  const rows = parse(src);
  const head = src.split("## 明细")[0].replace(/本表由脚本逐个枚举上游文件生成/, "本表复制自计划期覆盖清单，「Keel 落点」列改为仓内实际路径（scripts/port-check.mjs --init 生成）");
  // Planning-time notes can name private lanes; profile.local.json noteScrub rewrites them.
  const local = "config/profile.local.json";
  const pairs = existsSync(local) ? JSON.parse(readFileSync(local, "utf8")).noteScrub ?? [] : [];
  const scrub = (t) => pairs.reduce((acc, [from, to]) => acc.split(from).join(to), t);
  for (const r of rows) r.note = scrub(r.note);
  const body = rows.map((r) => `| ${r.type} | \`${r.path}\` | ${r.method} | ${targetsFor(r.path, r.method).map((t) => "`" + t + "`").join("<br>") || "—"} | ${r.phase} | ${r.note} |`).join("\n");
  writeFileSync(MAP, `${head}## 明细\n\n| 类型 | 上游路径 | 方式 | Keel 落点 | 阶段 | 备注 |\n|---|---|---|---|---|---|\n${body}\n`);
  console.log(`wrote ${MAP}: ${rows.length} rows`);
  process.exit(0);
}

const rows = parse(readFileSync(MAP, "utf8"));
if (opt("--upstream")) {
  const dir = opt("--upstream");
  const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const files = ["skills", "agents", "automations"].flatMap((d) => (existsSync(join(dir, d)) ? walk(join(dir, d)) : [])).map((p) => relative(dir, p));
  const relevant = files.filter((f) => f.endsWith("SKILL.md") || /playbooks\/|references\/|^agents\/|scripts\//.test(f));
  const known = new Set(rows.map((r) => r.path));
  const added = relevant.filter((f) => !known.has(f) && !f.includes("/templates/") && !(f.startsWith("automations/") && !f.endsWith("SKILL.md")));
  const removed = rows.filter((r) => !files.includes(r.path)).map((r) => r.path);
  console.log(`upstream ${opt("--sha") ?? ""}: added=${added.length} removed=${removed.length}`);
  for (const a of added) console.log(`  + ${a}`);
  for (const r of removed) console.log(`  - ${r}`);
}
const phase = opt("--phase") ?? "all";
const selected = phase === "all" ? rows : rows.filter((r) => r.phase === phase);
let unmapped = 0, missing = 0;
for (const r of selected) {
  const t = [...r.target.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  if (r.method !== "E" && !t.length) { unmapped++; console.log(`UNMAPPED ${r.path}`); continue; }
  for (const p of t) if (!existsSync(p)) { missing++; console.log(`MISSING ${r.path} → ${p}`); }
}
console.log(`phase=${phase} items=${selected.length}`);
console.log(`UNMAPPED=${unmapped} MISSING_TARGET=${missing}`);
process.exit(unmapped || missing ? 1 : 0);
