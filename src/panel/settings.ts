// Settings page: the key is handed straight to the host vault (/secrets); never to /kv or logs.
const input = document.querySelector<HTMLInputElement>("#key")!;
const statusEl = document.querySelector<HTMLElement>("#status")!;

async function refresh(): Promise<void> {
  const r = await fetch("/secrets");
  if (!r.ok) throw new Error("status");
  const entries = (await r.json()) as { key: string; saved: boolean; tail?: string }[];
  const key = entries.find((x) => x.key === "api_key");
  statusEl.textContent = key?.saved ? `凭证已保存${key.tail ? `（尾号 ${key.tail}）` : ""}` : "尚未配置凭证";
}

document.querySelector("#form")!.addEventListener("submit", async (event) => {
  event.preventDefault();
  const value = input.value.trim();
  input.value = "";
  if (!value) {
    statusEl.textContent = "请输入 API Key。";
    return;
  }
  try {
    const r = await fetch("/secrets/api_key", { method: "PUT", body: JSON.stringify({ value }) });
    if (r.status !== 204) throw new Error("save");
    await refresh();
  } catch {
    statusEl.textContent = "保存失败，请重新输入并重试。";
  }
});

document.querySelector("#clear")!.addEventListener("click", async () => {
  input.value = "";
  try {
    const r = await fetch("/secrets/api_key", { method: "DELETE" });
    if (!r.ok) throw new Error("clear");
    await refresh();
  } catch {
    statusEl.textContent = "清除失败，请重试。";
  }
});

// Lanes and paths are injected at build time from the personal profile (read-only here).
declare const __KEEL_PROFILE__: { lanes?: { repo: string; preset: string; preflight?: string }[]; routingPath?: string | null; plansDir?: string | null; boardRepos?: string[] };
const prof = typeof __KEEL_PROFILE__ === "undefined" ? {} : __KEEL_PROFILE__;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const lanesEl = document.querySelector<HTMLElement>("#lanes");
if (lanesEl) {
  const rows = (prof.lanes ?? []).map((l) => `<tr><td><code>${esc(l.repo)}</code></td><td>${esc(l.preset)}</td><td>${l.preflight ? "有" : "—"}</td></tr>`).join("") || '<tr><td colspan="3">未配置，所有仓按 personal 车道处理</td></tr>';
  lanesEl.innerHTML = `<table><thead><tr><th>仓库</th><th>车道</th><th>推送前预检</th></tr></thead><tbody>${rows}</tbody></table>
<p>派工路由：${prof.routingPath ? "已配置 routing.json" : "未配置（roles / fanout_plan 会 fail-closed）"}；计划目录：${prof.plansDir ? "已配置" : "目标仓 docs/"}；看板默认仓：${(prof.boardRepos ?? []).length} 个。</p>`;
}

refresh().catch(() => {
  statusEl.textContent = "无法读取配置状态，请重新打开插件详情。";
});
export {};
