// SC-17 / Step 0.5: block publishing if tracked files or any commit in history carry
// personal paths, private names (profile.local.json privateTerms), provider ids, emails,
// token-shaped strings or env files. Writes docs/privacy-scan.md.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const git = (...a) => execFileSync("git", a, { maxBuffer: 512 * 1024 * 1024 }).toString();
const local = "config/profile.local.json";
const privateTerms = existsSync(local) ? JSON.parse(readFileSync(local, "utf8")).privateTerms ?? [] : [];
const rules = [
  ["absolute-home-path", /\/Users\/[A-Za-z0-9._-]+|\/home\/[a-z][a-z0-9_-]+\//],
  ["email", /[A-Za-z0-9._%+-]+@(?!example\.(?:com|invalid|org)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ["sk-token", /\bsk-[A-Za-z0-9_-]{16,}/],
  ["bearer-literal", /Bearer [A-Za-z0-9._-]{16,}/],
  ...privateTerms.map((t) => [`private-term:${t.length}ch`, new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")]),
];
// Upstream MIT text keeps its author attribution; these exact lines are allowed.
const allow = [/Copyright \(c\) 2026 Lauren Tan/, /noreply@/, /git@github\.com/, /\/Users\/you\//];

const hits = [];
const files = git("ls-files").split("\n").filter(Boolean);
for (const f of files) {
  if (/(^|\/)\.env($|\.)/.test(f) && !f.endsWith(".env.example")) hits.push({ where: f, rule: "env-file", line: "" });
  let text;
  try { text = readFileSync(f, "utf8"); } catch { continue; }
  text.split("\n").forEach((line, i) => {
    if (allow.some((a) => a.test(line))) return;
    for (const [name, re] of rules) if (re.test(line)) hits.push({ where: `${f}:${i + 1}`, rule: name, line: line.trim().slice(0, 120) });
  });
}
// History: every added line in every commit reachable from HEAD.
const log = git("log", "-p", "--no-color", "--format=@@COMMIT %H", "HEAD");
let commit = "";
for (const line of log.split("\n")) {
  if (line.startsWith("@@COMMIT ")) { commit = line.slice(9, 16); continue; }
  if (!line.startsWith("+") || line.startsWith("+++")) continue;
  if (allow.some((a) => a.test(line))) continue;
  for (const [name, re] of rules) if (re.test(line)) hits.push({ where: `history ${commit}`, rule: name, line: line.slice(1).trim().slice(0, 120) });
}
const uniq = [...new Map(hits.map((h) => [`${h.where}|${h.rule}`, h])).values()];
const redact = (s) => privateTerms.reduce((acc, t) => acc.split(t).join("«private»"), s).replace(/\/Users\/[A-Za-z0-9._-]+/g, "/Users/«user»");
const md = `# 公开前隐私扫描

- 日期：${new Date().toISOString().slice(0, 10)}
- 范围：\`git ls-files\` ${files.length} 个文件 + HEAD 可达的全部提交（逐行扫描新增内容）
- 规则：本机绝对路径、邮箱、GitHub/sk token、Bearer 字面量、.env 文件、个人 profile 的私有名单（${privateTerms.length} 项，名单本身不入库）
- 结果：${uniq.length ? `**命中 ${uniq.length} 处，阻断公开**` : "未命中"}

${uniq.length ? "| 位置 | 规则 | 内容（已脱敏） |\n|---|---|---|\n" + uniq.slice(0, 200).map((h) => `| ${h.where} | ${h.rule} | \`${redact(h.line).replace(/\|/g, "\\|").replace(/`/g, "'")}\` |`).join("\n") : ""}
`;
writeFileSync("docs/privacy-scan.md", md);
if (uniq.length) {
  for (const h of uniq.slice(0, 60)) console.log(`HIT ${h.where} ${h.rule}`);
  console.log(`PRIVACY_BLOCKED ${uniq.length}`);
  process.exit(1);
}
console.log("PRIVACY_OK");
