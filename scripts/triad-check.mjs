// SC-15: the standard machine and both remotes must run the same Keel build.
// Local facts come from scripts/triad-facts.sh; remote facts are collected read-only by the
// agent (cindy_ssh, same script) into _tmp/triad-facts.json: [{label, ...facts}].
// Host names stay out of the repo: docs/triad.md uses labels only.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const local = JSON.parse(execFileSync("sh", ["scripts/triad-facts.sh"]).toString());
const remotes = existsSync("_tmp/triad-facts.json") ? JSON.parse(readFileSync("_tmp/triad-facts.json", "utf8")) : [];
const rows = [{ label: "本机（标准机）", ...local }, ...remotes];
const ref = rows[0];
const problems = [];
for (const r of rows) {
  if (!r.keel_version) problems.push(`${r.label}：未安装 Keel`);
  else if (r.keel_version !== ref.keel_version || r.keel_content_sha256 !== ref.keel_content_sha256) problems.push(`${r.label}：Keel 版本或内容与本机不一致`);
  if (!r.routing_sha256) problems.push(`${r.label}：缺 routing.json`);
}
const ok = rows.length === 3 && problems.length === 0;
const cell = (s) => (s ? `\`${String(s).slice(0, 16)}\`` : "—");
writeFileSync("docs/triad.md", `# 三机一致性

- 日期：${new Date().toISOString().slice(0, 10)}
- 方法：三台各跑一次 \`scripts/triad-facts.sh\`（远端经 cindy_ssh 只读执行），比较已安装 Keel 的版本与安装目录内容哈希、routing.json 是否存在。

| 机器 | Keel 版本 | 安装内容 sha256 | routing.json sha256 | Cindy | 工程目录 HEAD |
|---|---|---|---|---|---|
${rows.map((r) => `| ${r.label} | ${r.keel_version || "未安装"} | ${cell(r.keel_content_sha256)} | ${cell(r.routing_sha256)} | ${r.cindy_version || "—"} | ${cell(r.checkout_head)} |`).join("\n")}

结论：${ok ? "三台一致。" : problems.join("；") + "。"}
`);
for (const p of problems) console.log(`MISMATCH ${p}`);
console.log(ok ? "TRIAD_OK 3" : `TRIAD_MISMATCH ${problems.length}`);
process.exit(ok ? 0 : 1);
