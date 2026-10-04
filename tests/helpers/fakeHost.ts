import type { FetchResponse, Host, NodeResponse } from "../../src/main/host.ts";

export interface FakeHost extends Host {
  files: Map<string, string>;
  fetches: { url: string; body?: string }[];
  nodeCalls: { method: string; params: unknown }[];
  confirms: string[];
  broadcasts: unknown[];
  progressed: string[];
  clock: { t: number };
}

export function fakeHost(opts: {
  fetch?: (url: string, body?: string) => FetchResponse | Promise<FetchResponse>;
  node?: (method: string, params: any) => NodeResponse | Promise<NodeResponse>;
  confirm?: boolean;
} = {}): FakeHost {
  const files = new Map<string, string>();
  const clock = { t: Date.UTC(2026, 9, 4, 12, 0, 0) };
  const h: FakeHost = {
    files, clock,
    fetches: [], nodeCalls: [], confirms: [], broadcasts: [], progressed: [],
    async fetch(req) {
      h.fetches.push({ url: req.url, ...(req.body ? { body: req.body } : {}) });
      if (!opts.fetch) return { ok: false, status: 0, body: "" };
      return opts.fetch(req.url, req.body);
    },
    async node(method, params) {
      h.nodeCalls.push({ method, params });
      if (!opts.node) return { ok: false, message: "no node" };
      return opts.node(method, params);
    },
    async fs(req) {
      if (req.op === "write") { files.set(req.path!, req.content ?? ""); return { ok: true }; }
      if (req.op === "read") return files.has(req.path!) ? { ok: true, content: files.get(req.path!)! } : { ok: false, message: "not found" };
      if (req.op === "delete") { files.delete(req.path!); return { ok: true }; }
      const prefix = (req.path ? req.path + "/" : "");
      const names = new Set<string>();
      for (const k of files.keys()) if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split("/")[0]!);
      return { ok: true, entries: [...names].map((name) => ({ name })) };
    },
    async confirm(req) { h.confirms.push(req.body); return { ok: true, confirmed: opts.confirm ?? false }; },
    progress(callId) { h.progressed.push(callId); },
    badge() {},
    broadcast(m) { h.broadcasts.push(m); },
    now: () => clock.t,
    async sleep(ms) { clock.t += ms; },
  };
  return h;
}

/** Fake Typesafe that answers every question with a fixed confidence. */
export function typesafeAnswering(confidence: number, pick?: (id: string, q: any) => string) {
  return (url: string, body?: string): FetchResponse => {
    if (url.endsWith("/models")) return { ok: true, status: 200, body: JSON.stringify({ models: ["jev-latest"] }) };
    const req = JSON.parse(body ?? "{}");
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries<any>(req.questions)) {
      if (q.type === "noul") answers[id] = { type: "noul", noul: confidence };
      else if (q.type === "choice") {
        const choice = pick ? pick(id, q) : Object.keys(q.criteria)[0];
        answers[id] = { type: "choice", choice, confidence, probabilities: { [choice!]: confidence } };
      } else answers[id] = { type: "score", score: q.criteria.length - 1, confidence, probabilities: { a: confidence }, legend: {} };
    }
    return { ok: true, status: 200, body: JSON.stringify({ model: "jev-latest", answers, usage: { input_tokens: 10, output_tokens: 2 } }) };
  };
}
