// KEEL mainView: graph of runs + PR tab. Wake the brain, restore, then apply deltas.

import { applyGraphMessage, emptyStore, viewFromStore, type GraphStore } from "./graph-model.ts";

const ch = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("keel") : null;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const pending = new Map<string, number>();
let store: GraphStore = emptyStore();

async function wake(): Promise<void> {
  try {
    await fetch("/wake");
  } catch {
    try {
      await fetch("cindy-ghost://keel/wake");
    } catch {
      /* resend loop covers a sleeping brain */
    }
  }
}

async function ask(op: string): Promise<void> {
  await wake();
  const reqId = `${op}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  let tries = 0;
  const send = () => {
    if (!pending.has(reqId) || tries++ > 20) return void pending.delete(reqId);
    ch?.postMessage({ reqId, op });
    pending.set(reqId, window.setTimeout(send, 500));
  };
  pending.set(reqId, 0);
  send();
}

function renderRuns(): void {
  const box = document.querySelector("#runs");
  if (!box) return;
  const view = viewFromStore(store, Date.now());
  if (view.empty) {
    box.textContent = view.empty_message;
    return;
  }
  box.innerHTML = view.runs.map((r) => {
    const nodes = r.nodes.map((n) => `<li class="${n.current ? "current" : ""}"><b>${esc(n.id)}</b> ${esc(n.dispatch_state)}${n.worker_label ? ` · ${esc(n.worker_label)}` : ""}</li>`).join("");
    const workers = r.workers.length
      ? r.workers.map((w) => `<div class="meta">${esc(w.label)} · ${esc(w.model)} / ${esc(w.effort)} · ${esc(w.dispatch_state)}</div>`).join("")
      : `<div class="meta">无在途 worker</div>`;
    const jev = r.jev.length
      ? r.jev.map((j) => `<div class="meta">${esc(j.gate)} → ${esc(j.choice)} (${esc(j.confidence)}, ${esc(j.routed)})</div>`).join("")
      : `<div class="meta">无 Jev 记录</div>`;
    const sol = r.sol_decisions.length
      ? r.sol_decisions.map((d) => `<div class="meta">${esc(d.gate)}：${esc(d.answer)}</div>`).join("")
      : `<div class="meta">无主控裁决</div>`;
    const gates = r.human_gates.length ? r.human_gates.map((g) => `<span class="tag warn">${esc(g)}</span>`).join("") : `<span class="meta">无人工门</span>`;
    const pr = r.github.url ? `<a href="${esc(r.github.url)}">${esc(r.github.label)}</a>` : esc(r.github.label);
    return `<article class="row run">
      <h2>${esc(r.run_id)} <span class="tag">${esc(r.status)}</span> <span class="meta">${esc(r.elapsed)}</span></h2>
      <p>${esc(r.goal)}</p>
      <p class="meta">当前节点：${esc(r.current_nodes.join("、") || "—")}</p>
      <ul class="nodes">${nodes || "<li class=\"meta\">无节点</li>"}</ul>
      <h3>在途 worker</h3>${workers}
      <h3>Jev</h3>${jev}
      <h3>主控裁决</h3>${sol}
      <h3>Astra</h3><div class="meta">调用 ${esc(r.astra.calls)} · 剩余 ${esc(r.astra.left)} · 最近 ${esc(r.astra.last)}</div>
      <h3>人工门</h3><div>${gates}</div>
      <h3>GitHub</h3><div class="meta">${pr} · CI ${esc(r.github.ci)} · ${esc(r.github.mergeable)}</div>
    </article>`;
  }).join("");
}

function renderBoard(rows: any[], at: string): void {
  const atEl = document.querySelector("#at");
  const board = document.querySelector("#board");
  if (atEl) atEl.textContent = at ? `更新于 ${new Date(at).toLocaleTimeString()}` : "";
  if (!board) return;
  if (!rows.length) {
    board.textContent = "没有你名下的 open PR。";
    return;
  }
  board.innerHTML = rows.map((r) => {
    const cls = r.error ? "bad" : r.mergeable ? "ok" : r.decision?.kind === "blocker" ? "bad" : "warn";
    const state = r.error ? `读取失败：${esc(r.error)}` : r.mergeable ? "可合并（请在 GitHub 合并）" : esc(r.decision?.blocker ?? r.decision?.kind);
    return `<div class="row"><a href="${esc(r.url)}">${esc(r.repo)}#${esc(r.number)}</a> ${esc(r.title)}<div class="meta"><span class="tag">${esc(r.preset)}</span>${r.handed_off ? '<span class="tag">已交接</span>' : ""}<span class="${cls}">${state}</span>${r.next_action ? ` · 下一步 ${esc(r.next_action)}` : ""}</div></div>`;
  }).join("");
}

if (ch) {
  ch.addEventListener("message", (ev) => {
    const m = ev.data;
    if (m?.type === "ack" && pending.has(m.reqId)) {
      clearTimeout(pending.get(m.reqId));
      pending.delete(m.reqId);
    } else if (m?.type === "graph" || m?.type === "graph-delta") {
      store = applyGraphMessage(store, m);
      renderRuns();
    } else if (m?.type === "board") renderBoard(m.rows ?? [], m.at ?? "");
    else if (m?.type === "error") {
      const msg = document.querySelector("#msg");
      if (msg) msg.textContent = m.message;
    }
  });
}

if (typeof document !== "undefined") {
  document.querySelectorAll<HTMLButtonElement>("nav button").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("on", x === b));
      document.querySelectorAll("section").forEach((s) => ((s as HTMLElement).hidden = s.id !== b.dataset.tab));
    }),
  );
  document.querySelector("#refresh")?.addEventListener("click", () => {
    const msg = document.querySelector("#msg");
    if (msg) msg.textContent = "正在读取…";
    void ask("board");
  });
  document.querySelector("#graph-refresh")?.addEventListener("click", () => void ask("graph"));
  void ask("restore");
}

export {};
