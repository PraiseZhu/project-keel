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

refresh().catch(() => {
  statusEl.textContent = "无法读取配置状态，请重新打开插件详情。";
});
export {};
