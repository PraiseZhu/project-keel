import { dashboardFixture, makeRun, saveRun } from "../tests/dashboard/fixtures.ts";
import { makeContext } from "../src/main/context.ts";
import { refreshDashboard, restoreDashboard, updateDashboardLocal } from "../src/main/dashboard/service.ts";
import { pullKey, type RemotePull } from "../src/shared/dashboard.ts";

class PreviewChannel {
  static channels = new Map<string, Set<PreviewChannel>>();
  readonly handlers = new Set<(event: { data: unknown }) => void>();
  constructor(readonly name: string) {
    const peers = PreviewChannel.channels.get(name) ?? new Set();
    peers.add(this); PreviewChannel.channels.set(name, peers);
  }
  addEventListener(name: string, handler: (event: { data: unknown }) => void) { if (name === "message") this.handlers.add(handler); }
  postMessage(data: unknown) {
    for (const peer of PreviewChannel.channels.get(this.name) ?? []) if (peer !== this) {
      const copied = structuredClone(data);
      queueMicrotask(() => { for (const handler of peer.handlers) handler({ data: copied }); });
    }
  }
  close() { PreviewChannel.channels.get(this.name)?.delete(this); this.handlers.clear(); }
}

Object.assign(globalThis, { BroadcastChannel: PreviewChannel });
const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => String(input) === "/wake" ? Promise.resolve(new Response("ok")) : originalFetch(input, init)) as typeof fetch;
const channel = new PreviewChannel("keel");
const { host, controls } = dashboardFixture();
host.broadcast = (message: unknown) => { host.broadcasts.push(message); channel.postMessage(message); };
const context = makeContext(host, "preview", { lanes: [], boardRepos: [], routingPath: null, plansDir: null }, undefined, "lead");
let tail = Promise.resolve();
channel.addEventListener("message", ({ data }) => {
  const message = data as Record<string, unknown>;
  if (!message?.reqId || !message.op) return;
  channel.postMessage({ type: "ack", reqId: message.reqId, target: message.panelId });
  tail = tail.then(async () => {
    host.clock.t = Date.now();
    const scope = message.scope === "all" ? "all" : "open";
    if (message.op === "dashboard-restore") {
      await restoreDashboard(context, scope, String(message.panelId));
      channel.postMessage({ type: "dashboard-done", reqId: message.reqId, target: message.panelId });
    } else if (message.op === "dashboard") {
      const snapshot = await refreshDashboard(context, { scope, force: message.force === true });
      channel.postMessage({ type: "dashboard-response", reqId: message.reqId, target: message.panelId, scope, complete: snapshot.complete, retryAt: snapshot.retryAt, error: snapshot.error });
    } else if (message.op === "dashboard-local") {
      await updateDashboardLocal(context, scope, String(message.key));
      channel.postMessage({ type: "dashboard-done", reqId: message.reqId, target: message.panelId });
    } else if (message.op === "dashboard-detail") {
      channel.postMessage({ type: "dashboard-detail", reqId: message.reqId, target: message.panelId, key: message.key, detail: { rendered: "测试预览：这里核对当前提交的检查、评审和 Keel 门禁。不会执行模型，也不会修改 GitHub。" } });
    }
  }).catch((error) => channel.postMessage({ type: "dashboard-error", reqId: message.reqId, target: message.panelId, message: String(error) }));
});

Object.assign(globalThis, { __KEEL_PREVIEW__: {
  host, controls,
  offline(value: boolean) { controls.fail = value; host.clock.t = Date.now(); },
  patch(repo: string, number: number, patch: Partial<RemotePull>) {
    const row = controls.rows.find((candidate) => candidate.key === pullKey(repo, number));
    if (row) Object.assign(row, patch, { updatedAt: new Date().toISOString() });
  },
  move(repo: string, number: number, cursor: string, step?: number) {
    const row = controls.rows.find((candidate) => candidate.key === pullKey(repo, number));
    if (!row) return;
    const run = makeRun(row, cursor, Date.now());
    if (step) run.progress = { nodeId: cursor, dispatchKey: run.nodes[cursor]!.dispatch_key!, step, at: Date.now() };
    saveRun(host, run);
    channel.postMessage({ type: "dashboard-invalidated", key: row.key });
  },
  async step(repo: string, number: number, step: number) {
    this.move(repo, number, "implement", step);
  },
} });
document.title = "KEEL · 测试数据预览";
