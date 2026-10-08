// Cindy's fs list on root:"data" returns every file below the requested path, recursively,
// as { path: "<relative to data root>", bytes, mtime } (fsSlot.ts handleData). KEEL callers
// expect the direct children of `path` as { name }. Convert here so callers stay simple.

import type { FsResponse } from "./host.ts";

export function toChildEntries(listPath: string | undefined, raw: FsResponse): FsResponse {
  if (!raw.ok || !Array.isArray(raw.entries)) return raw;
  const prefix = listPath ? `${listPath.replace(/\/+$/, "")}/` : "";
  const names = new Set<string>();
  for (const e of raw.entries as readonly Record<string, unknown>[]) {
    if (typeof e.name === "string") {
      names.add(e.name);
      continue;
    }
    if (typeof e.path !== "string" || !e.path.startsWith(prefix)) continue;
    const first = e.path.slice(prefix.length).split("/")[0];
    if (first) names.add(first);
  }
  return { ...raw, entries: [...names].sort().map((name) => ({ name })) };
}
