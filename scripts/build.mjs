// Build the Cindy plugin bundles from src/ into plugin/.
// The personal profile (config/profile.local.json, gitignored) is injected here so
// the public source tree never carries personal paths or internal repo names.
import { build } from "esbuild";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const localProfile = join(root, "config/profile.local.json");
const exampleProfile = join(root, "config/profile.example.json");
const profilePath = process.env.KEEL_PROFILE || (existsSync(localProfile) ? localProfile : exampleProfile);
const raw = JSON.parse(readFileSync(profilePath, "utf8"));
// privateTerms only feeds the privacy scan; it must never ship in the bundle.
const { privateTerms: _drop, ...profile } = raw;
// Playbook steps for pstack_start, read from the synced manual mirror.
const pbDir = join(root, "plugin/manual/pstack/skills/poteto-mode/playbooks");
const playbooks = {};
if (existsSync(pbDir)) {
  for (const f of readdirSync(pbDir).filter((x) => x.endsWith(".md"))) {
    const text = readFileSync(join(pbDir, f), "utf8");
    const upstream = text.split("\n---\n").pop();
    const steps = [...upstream.matchAll(/^\d+\. (.+)$/gm)].map((m) => (m[1].match(/^\*\*(.+?)\*\*/)?.[1] ?? m[1].split(/(?<=[.!?])\s/)[0]).slice(0, 200)).slice(0, 20);
    playbooks[f.replace(/\.md$/, "")] = { summary: (upstream.match(/^\*\*(.+?)\*\*/m)?.[1] ?? "").slice(0, 240), steps };
  }
}
const define = { __KEEL_PROFILE__: JSON.stringify(profile), __KEEL_PLAYBOOKS__: JSON.stringify(playbooks) };

const common = { bundle: true, legalComments: "none", logLevel: "warning", define, target: "es2022" };
await build({ ...common, entryPoints: [join(root, "src/main/index.ts")], outfile: join(root, "plugin/main.js"), format: "iife", platform: "browser" });
await build({ ...common, entryPoints: [join(root, "src/node/worker.ts")], outfile: join(root, "plugin/node/worker.cjs"), format: "cjs", platform: "node", target: "node20" });
await build({ ...common, entryPoints: [join(root, "src/panel/panel.ts")], outfile: join(root, "plugin/panel.js"), format: "iife", platform: "browser" });
await build({ ...common, entryPoints: [join(root, "src/panel/settings.ts")], outfile: join(root, "plugin/settings.js"), format: "iife", platform: "browser" });

// Profile page for the keel manual unit (generated, gitignored).
const lanes = (profile.lanes ?? []).map((l) => `| \`${l.repo}\` | ${l.preset} | ${l.preflight ? "`" + l.preflight + "`" : "—"} |`).join("\n") || "| （未配置） | personal | — |";
const md = `# 本机配置（构建时生成）

> 由 \`scripts/build.mjs\` 从个人 profile 生成；源文件不入库。

## 车道表

| 仓库 | 车道预设 | 推送前预检 |
|---|---|---|
${lanes}

未列出的仓一律按 \`personal\` 车道处理。

## 路径

- 派工路由（routing.json）：${profile.routingPath ? "`" + profile.routingPath + "`" : "未配置（roles / fanout_plan 会 fail-closed）"}
- 计划落点：${profile.plansDir ? "`" + profile.plansDir + "`" : "目标仓 docs/"}
- 看板默认仓：${(profile.boardRepos ?? []).map((r) => "`" + r + "`").join("、") || "未配置"}

## 个人规则补充

${profile.overlayNote || "（无）"}
`;
const manualDir = join(root, "plugin/manual/keel");
mkdirSync(manualDir, { recursive: true });
writeFileSync(join(manualDir, "profile.md"), md);
console.log(`built with profile ${profilePath === localProfile ? "local" : profilePath === exampleProfile ? "example" : profilePath}`);
