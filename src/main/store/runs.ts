// Per-run serial transactions over runs/<id>/graph-state.json (host.fs, root=data).

import { KeelError, type Host } from "../host.ts";

const RUN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type GraphState = { run_id?: string; [key: string]: unknown };

const tails = new WeakMap<Host, Map<string, Promise<void>>>();

function chainOf(host: Host): Map<string, Promise<void>> {
  let m = tails.get(host);
  if (!m) {
    m = new Map();
    tails.set(host, m);
  }
  return m;
}

export function graphStatePath(runId: string): string {
  if (!RUN_ID.test(runId)) throw new KeelError("INVALID_INPUT", "run_id 只能含小写字母、数字和连字符。");
  return `runs/${runId}/graph-state.json`;
}

async function load(host: Host, runId: string): Promise<GraphState> {
  const path = graphStatePath(runId);
  const r = await host.fs({ op: "read", root: "data", path });
  if (!r.ok) {
    if (!r.message || /not found|ENOENT/i.test(r.message)) return {};
    throw new KeelError("RUN_STATE_READ_FAILED", `读取 graph-state 失败：${r.message}`);
  }
  if (!r.content) return {};
  try {
    const parsed = JSON.parse(r.content) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as GraphState;
  } catch {
    throw new KeelError("RUN_STATE_INVALID", `run ${runId} 的 graph-state.json 不是合法 JSON。`);
  }
}

async function save(host: Host, runId: string, state: GraphState): Promise<void> {
  const path = graphStatePath(runId);
  const w = await host.fs({ op: "write", root: "data", path, content: JSON.stringify(state) });
  if (!w.ok) throw new KeelError("RUN_STATE_WRITE_FAILED", `写入 graph-state 失败：${w.message ?? "未知原因"}`);
}

/**
 * Serialize the read → fn mutate → write of one run's graph-state.json.
 * Concurrent withRun calls on the same host+runId never drop updates.
 */
export function withRun<T>(host: Host, runId: string, fn: (state: GraphState) => T | Promise<T>): Promise<T> {
  graphStatePath(runId);
  const chains = chainOf(host);
  const prev = chains.get(runId) ?? Promise.resolve();
  const run = prev.then(async () => {
    const state = await load(host, runId);
    if (!state.run_id) state.run_id = runId;
    const result = await fn(state);
    await save(host, runId, state);
    return result;
  });
  chains.set(
    runId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export function artifactPath(runId: string, rel: string): string {
  graphStatePath(runId);
  if (!/^[A-Za-z0-9._/-]{1,128}$/.test(rel) || rel.includes("..")) {
    throw new KeelError("INVALID_INPUT", "artifact 路径不合法。");
  }
  return `runs/${runId}/artifacts/${rel}`;
}

/** Serialize artifact writes on the same host+runId chain as graph-state. */
export function writeRunArtifact(host: Host, runId: string, rel: string, content: string): Promise<void> {
  const path = artifactPath(runId, rel);
  const chains = chainOf(host);
  const prev = chains.get(runId) ?? Promise.resolve();
  const run = prev.then(async () => {
    const w = await host.fs({ op: "write", root: "data", path, content });
    if (!w.ok) throw new KeelError("RUN_STATE_WRITE_FAILED", `写入 artifact 失败：${w.message ?? "未知原因"}`);
  });
  chains.set(
    runId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}
