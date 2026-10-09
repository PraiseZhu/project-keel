// Mirror upstream pstack into plugin/manual/pstack/: strip frontmatter (Host rejects it),
// add a provenance header, apply tools/substitutions.json, prepend tools/forks.json overlays,
// and turn non-.md references into .md code blocks. Output is deterministic; re-run after
// bumping tools/upstream.json.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const up = JSON.parse(readFileSync(join(root, "tools/upstream.json"), "utf8"));
const subs = JSON.parse(readFileSync(join(root, "tools/substitutions.json"), "utf8"));
const forks = JSON.parse(readFileSync(join(root, "tools/forks.json"), "utf8"));
const local = join(root, "config/profile.local.json");
const src = process.env.KEEL_UPSTREAM_DIR || (existsSync(local) ? JSON.parse(readFileSync(local, "utf8")).upstreamDir : null);
if (!src || !existsSync(src)) {
  console.error("upstream checkout not found: set KEEL_UPSTREAM_DIR or profile.local.json upstreamDir");
  process.exit(2);
}
const out = join(root, "plugin/manual/pstack");
const short = up.sha.slice(0, 7);
const MAX = 64 * 1024;

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = up.mirror.flatMap((d) => walk(join(src, d))).map((p) => relative(src, p)).filter((p) => !up.skip.some((s) => p.startsWith(s))).sort();
const converted = files.filter((p) => extname(p) !== ".md");
const target = (p) => (extname(p) === ".md" ? p : `${p}.md`);

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return { meta, body: text.slice(m[0].length) };
}

function substitute(text) {
  let t = text;
  for (const s of subs) t = s.regex ? t.replace(new RegExp(s.regex, "g"), s.replace) : t.split(s.find).join(s.replace);
  for (const c of converted) {
    const base = c.split("/").pop();
    t = t.split(base).join(`${base}.md`).split(`${base}.md.md`).join(`${base}.md`);
  }
  return t;
}

rmSync(out, { recursive: true, force: true });
const index = { skills: [], playbooks: [], agents: [], automations: [] };
const report = { files: 0, forked: 0, converted: converted.length, oversize: [] };
for (const rel of files) {
  const raw = readFileSync(join(src, rel), "utf8");
  const fork = forks.find((f) => f.path === rel);
  let body;
  let meta = {};
  if (extname(rel) === ".md") {
    ({ meta, body } = frontmatter(raw));
    body = substitute(body);
  } else {
    const lang = extname(rel).slice(1);
    body = `原文件 \`${rel.split("/").pop()}\`（非 Markdown，按 Host 手册规则转为代码块）：\n\n\`\`\`${lang}\n${raw.replace(/\n$/, "")}\n\`\`\`\n`;
  }
  const how = fork ? `${fork.kind}：${fork.why}` : "仅宿主名词替换";
  const metaLine = meta.description ? `\n> 上游说明（${meta.name ?? rel}）：${meta.description}\n` : "";
  const overlay = fork ? "\n" + readFileSync(join(root, fork.overlay), "utf8").trim() + "\n" : "";
  const text = `> 移植自 pstack ${rel} @ ${short}（MIT）。改写：${how}\n${metaLine}${overlay}\n${body.replace(/^\n+/, "")}`;
  const dest = join(out, target(rel));
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, text);
  report.files++;
  if (fork) report.forked++;
  if (Buffer.byteLength(text) > MAX) report.oversize.push(rel);
  const p = target(rel);
  if (/^skills\/[^/]+\/SKILL\.md$/.test(rel)) index.skills.push([p, meta.description ?? ""]);
  else if (/playbooks\/[^/]+\.md$/.test(rel)) index.playbooks.push([p, (body.match(/^\*\*(.+?)\*\*/m)?.[1] ?? "").slice(0, 160)]);
  else if (rel.startsWith("agents/")) index.agents.push([p, meta.description ?? ""]);
  else if (/^automations\/.+SKILL\.md$/.test(rel)) index.automations.push([p, meta.description ?? ""]);
}

const call = (p) => `\`ghost_manual({ ghost_id: "keel", path: "pstack/${p}" })\``;
const row = ([p, d]) => `| ${call(p)} | ${d.replace(/\|/g, "\\|").slice(0, 200)} |`;
const manual = `# pstack 上游镜像（Keel）

> 镜像自 cursor/plugins pstack ${up.version} @ ${up.sha}（MIT，© 2026 Lauren Tan）。由 \`tools/sync.mjs\` 生成，勿手改。

正文保留上游英文；每个文件首行写明来源与改写方式。**中文规则覆盖层与 Cursor→Cindy 对照在 \`keel\` 手册单元**：${"`"}ghost_manual({ ghost_id: "keel", path: "keel/MANUAL.md" })${"`"}，与上游冲突时以覆盖层为准。

## 怎么用

1. 先调 \`pstack_start({ task })\`，它用 Jev 选 playbook 并给出下面表里的路径；用户点名 playbook 时传 \`playbook\`。
2. 路由与非协商规则：${call("skills/poteto-mode/SKILL.md")}。
3. 判断点用 \`pstack_decide\`（J1–J12），留痕用 \`pstack_decide({ op: "log" })\`。

## Playbooks（${index.playbooks.length}）

| 路径 | 开头规则 |
|---|---|
${index.playbooks.map(row).join("\n")}

## Skills（${index.skills.length}）

| 路径 | 上游说明 |
|---|---|
${index.skills.map(row).join("\n")}

## Agents（${index.agents.length}）→ 在 Keel 中是车道模板，不注册 agent 类型

| 路径 | 上游说明 |
|---|---|
${index.agents.map(row).join("\n")}

## Automations（${index.automations.length}，上游为休眠包）

| 路径 | 上游说明 |
|---|---|
${index.automations.map(row).join("\n")}

各 skill 的 \`references/\` 与 playbook 间的相对链接保持上游目录结构，可按同样的 \`pstack/<上游相对路径>\` 读取（非 .md 文件追加 \`.md\` 后缀）。
`;
writeFileSync(join(out, "MANUAL.md"), manual);
console.log(JSON.stringify({ ...report, index: Object.fromEntries(Object.entries(index).map(([k, v]) => [k, v.length])) }));
if (report.oversize.length) process.exit(1);
