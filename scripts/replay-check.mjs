// SC-9 / SC-11: each replay record must have every section and end in PASS.
import { existsSync, readFileSync } from "node:fs";

const SECTIONS = ["## 用户输入", "## 路由与 Jev", "## 工具调用序列", "## 台账", "## 最终状态与证据"];
let ok = 0;
for (const f of process.argv.slice(2)) {
  if (!existsSync(f)) { console.log(`MISSING ${f}`); continue; }
  const t = readFileSync(f, "utf8");
  const missing = SECTIONS.filter((s) => !t.includes(s));
  const result = t.match(/^结果：(PASS|FAIL)/m)?.[1] ?? "NONE";
  if (missing.length || result !== "PASS") console.log(`NOT_OK ${f}: result=${result}${missing.length ? ` missing=${missing.join(",")}` : ""}`);
  else ok++;
}
console.log(ok === process.argv.length - 2 ? `REPLAYS_OK ${ok}` : `REPLAYS_INCOMPLETE ${ok}/${process.argv.length - 2}`);
process.exit(ok === process.argv.length - 2 ? 0 : 1);
