// GET /kv response check shared by the electron brain and the settings page.
// A failed read must fail closed: callers that would post or overwrite /kv stop instead.

export class KvReadError extends Error {}

export function parseKvResponse(status: number, ok: boolean, data: unknown): Record<string, unknown> {
  if (!ok) throw new KvReadError(`读取 /kv 失败（HTTP ${status}）。`);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new KvReadError(`读取 /kv 返回的不是对象（${data === null ? "null" : Array.isArray(data) ? "数组" : typeof data}）。`);
  }
  return data as Record<string, unknown>;
}
