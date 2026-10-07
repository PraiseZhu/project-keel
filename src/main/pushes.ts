// Local push timestamps for the no-checks grace window. Keyed by repo+head in
// the plugin data directory. Never use commit time: Mivo commits can predate the push.

import type { Host } from "./host.ts";

export interface LocalPush {
  readonly repo: string;
  readonly head: string;
  readonly at_ms: number;
}

const file = (repo: string, head: string) =>
  `pushes/${repo.replace("/", "__").toLowerCase()}__${head.toLowerCase()}.json`;

export async function recordLocalPush(host: Host, repo: string, head: string, atMs: number): Promise<void> {
  const rec: LocalPush = { repo, head, at_ms: atMs };
  await host.fs({ op: "write", root: "data", path: file(repo, head), content: JSON.stringify(rec) });
}

export async function listLocalPushes(host: Host): Promise<LocalPush[]> {
  const list = await host.fs({ op: "list", root: "data", path: "pushes" });
  if (!list.ok) return [];
  const out: LocalPush[] = [];
  for (const e of list.entries ?? []) {
    const r = await host.fs({ op: "read", root: "data", path: `pushes/${e.name}` });
    if (!r.ok || !r.content) continue;
    try {
      const j = JSON.parse(r.content) as Partial<LocalPush>;
      if (typeof j.repo === "string" && typeof j.head === "string" && typeof j.at_ms === "number")
        out.push({ repo: j.repo, head: j.head, at_ms: j.at_ms });
    } catch {
      /* skip unreadable records */
    }
  }
  return out;
}
