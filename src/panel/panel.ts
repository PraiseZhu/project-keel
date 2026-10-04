// Panel: PR board, fanout lanes, decision ledger. Talks to main.js over BroadcastChannel;
// wakes the brain first, then resends each request until it is acked. No merge button.

const ch = new BroadcastChannel("keel");
const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
const pending = new Map<string, number>();
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

async function ask(op: string): Promise<void> {
  try {
    await fetch("cindy-ghost://keel/wake");
  } catch {
    /* already awake or asleep; resend loop below covers both */
  }
  const reqId = `${op}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  let tries = 0;
  const send = () => {
    if (!pending.has(reqId) || tries++ > 20) return void pending.delete(reqId);
    ch.postMessage({ reqId, op });
    pending.set(reqId, window.setTimeout(send, 500));
  };
  pending.set(reqId, 0);
  send();
}

function renderBoard(rows: any[], at: string): void {
  $("#at").textContent = `更新于 ${new Date(at).toLocaleTimeString()}`;
  if (!rows.length) return void ($("#board").textContent = "没有你名下的 open PR。");
  $("#board").innerHTML = rows.map((r) => {
    const cls = r.error ? "bad" : r.mergeable ? "ok" : r.decision?.kind === "blocker" ? "bad" : "warn";
    const state = r.error ? `读取失败：${esc(r.error)}` : r.mergeable ? "可合并（请在 GitHub 合并）" : esc(r.decision?.blocker ?? r.decision?.kind);
    return `<div class="row"><a href="${esc(r.url)}">${esc(r.repo)}#${esc(r.number)}</a> ${esc(r.title)}<div class="meta"><span class="tag">${esc(r.preset)}</span>${r.handed_off ? '<span class="tag">已交接</span>' : ""}<span class="${cls}">${state}</span>${r.next_action ? ` · 下一步 ${esc(r.next_action)}` : ""}</div></div>`;
  }).join("");
}

ch.addEventListener("message", (ev) => {
  const m = ev.data;
  if (m?.type === "ack" && pending.has(m.reqId)) {
    clearTimeout(pending.get(m.reqId));
    pending.delete(m.reqId);
  } else if (m?.type === "board") renderBoard(m.rows ?? [], m.at);
  else if (m?.type === "ledger") {
    $("#ledger-list").innerHTML = (m.rows ?? []).slice().reverse().map((r: any) => `<div class="row"><b>${esc(r.kind)}</b> ${esc(r.summary)}<div class="meta">${esc(r.at)} · ${esc(r.run_id)}${r.confidence !== undefined ? ` · confidence ${Number(r.confidence).toFixed(2)}` : ""}</div></div>`).join("") || esc(m.message ?? "还没有决策记录。");
  } else if (m?.type === "fanout") {
    $("#fanout-list").innerHTML = (m.lanes ?? []).map((l: any) => `<div class="row"><b>${esc(l.label)}</b> ${esc(l.role)} <span class="meta">${esc(l.route?.model)}/${esc(l.route?.effort)} · ${esc(l.working_dir ?? "只读")}</span></div>`).join("");
  } else if (m?.type === "scheduled") $("#msg").textContent = "已为你打开自动化创建面板，请去自动化页确认保存。";
  else if (m?.type === "error") $("#msg").textContent = m.message;
});

document.querySelectorAll<HTMLButtonElement>("nav button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("on", x === b));
    document.querySelectorAll("section").forEach((s) => (s.hidden = s.id !== b.dataset.tab));
    if (b.dataset.tab === "ledger") void ask("ledger");
  }),
);
$("#refresh").addEventListener("click", () => {
  $("#msg").textContent = "正在读取…";
  void ask("board");
});
$("#ledger-refresh").addEventListener("click", () => void ask("ledger"));
$("#schedule").addEventListener("click", () => void ask("schedule"));

export {};
