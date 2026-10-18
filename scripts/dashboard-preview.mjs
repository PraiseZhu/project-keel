import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const inline = (value) => value.replace(/<\/script/gi, "<\\/script");
const renderHtml = async () => {
  const bundled = await build({ entryPoints: [join(root, "scripts/dashboard-preview-bridge.ts")], bundle: true, write: false, platform: "browser", format: "iife", target: "es2022" });
  return readFileSync(join(root, "plugin/panel.html"), "utf8")
  .replace('<link rel="stylesheet" href="panel.css">', `<style>${readFileSync(join(root, "plugin/panel.css"), "utf8")}</style>`)
  .replace('<script src="panel.js"></script>', `<script>${inline(bundled.outputFiles[0].text)}</script><script>${inline(readFileSync(join(root, "plugin/panel.js"), "utf8"))}</script>`)
  .replace("<body>", '<body data-preview="fixture">')
  .replace("</body>", '<div style="position:fixed;bottom:0;left:0;padding:2px 6px;font:9px system-ui;background:#17212b;color:#adc3d1;z-index:1000;pointer-events:none">测试数据预览 · 不执行模型 / GitHub 写入</div></body>');
};
const output = join(root, "_tmp/dashboard-validation/keel-dashboard-preview.html");
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, await renderHtml());
if (process.argv.includes("--export")) {
  console.log(`SELF_CONTAINED_PREVIEW=${output}`);
} else {
  const server = createServer(async (request, response) => {
    if (request.url !== "/" && request.url !== "/index.html") { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(await renderHtml());
  });
  server.listen(0, "127.0.0.1", () => console.log(`KEEL_DASHBOARD_PREVIEW=http://127.0.0.1:${server.address().port}`));
}
