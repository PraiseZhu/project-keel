// Map interpreter plugin_task ops onto Cindy §4.11.3 cindy.tasks.
// KEEL's electron brain calls this itself; the lead does not invoke cindy.tasks.

export type PluginTaskPhase = "create" | "send" | "getRun" | "readMessages" | "list";

export interface CindyTasksApi {
  create(args: Record<string, unknown>): Promise<unknown>;
  send(args: Record<string, unknown>): Promise<unknown>;
  getRun(args: Record<string, unknown>): Promise<unknown>;
  readMessages(args: Record<string, unknown>): Promise<unknown>;
  list?(args: Record<string, unknown>): Promise<unknown>;
}

export interface PluginTaskInput {
  readonly phase: PluginTaskPhase;
  readonly request_key?: string;
  readonly body?: Record<string, unknown>;
  readonly task_id?: string;
  readonly expected_revision?: number;
  readonly text?: string;
  readonly run_id?: string;
  readonly task_run_id?: string;
  readonly title?: string;
  readonly after?: string;
}

export const READ_MESSAGES_MAX_PAGES = 8;

export function toCindyTasksCall(input: PluginTaskInput): { method: PluginTaskPhase; args: Record<string, unknown> } {
  if (input.phase === "create") {
    const body = input.body ?? {};
    const route = {
      agentKind: body.agentKind,
      providerId: body.providerId,
      model: body.model,
      effort: body.effort ?? "",
      fastMode: body.fastMode === true,
    };
    return {
      method: "create",
      args: {
        requestKey: input.request_key,
        title: input.title ?? "KEEL node",
        isolatedWorkspace: body.isolatedWorkspace !== false,
        route,
      },
    };
  }
  if (input.phase === "send") {
    const rev = input.expected_revision;
    const args: Record<string, unknown> = {
      taskId: input.task_id,
      requestKey: input.request_key,
      text: input.text ?? "",
    };
    if (typeof rev === "number" && Number.isSafeInteger(rev) && rev >= 0) args.expectedRevision = rev;
    return { method: "send", args };
  }
  if (input.phase === "getRun") {
    return { method: "getRun", args: { runId: input.task_run_id ?? input.run_id } };
  }
  if (input.phase === "list") {
    return { method: "list", args: { limit: 100 } };
  }
  return {
    method: "readMessages",
    args: { taskId: input.task_id, limit: 50, ...(input.after ? { after: input.after } : {}) },
  };
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

function pageItems(data: unknown): unknown[] {
  const o = rec(data);
  if (Array.isArray(o.items)) return o.items;
  if (Array.isArray(o.messages)) return o.messages;
  return [];
}

function pageCursor(data: unknown): string | undefined {
  const c = rec(data).nextCursor;
  return typeof c === "string" && c ? c : undefined;
}

function pageHasFinal(items: unknown[]): boolean {
  for (const m of items) {
    const row = rec(m);
    const text = [row.text, row.content, row.body].find((x) => typeof x === "string" && x) as string | undefined;
    if (!text) continue;
    const fence = text.match(/```json\s*([\s\S]*?)```/);
    const raw = fence?.[1] ?? (text.trim().startsWith("{") ? text : undefined);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as { status?: unknown }).status === "string") return true;
    } catch { /* next */ }
  }
  return false;
}

export async function collectTaskMessages(api: CindyTasksApi, taskId: string): Promise<{ ok: true; data: { items: unknown[]; messages: unknown[] } } | { ok: false; errorCode: string; message: string }> {
  const items: unknown[] = [];
  let after: string | undefined;
  for (let i = 0; i < READ_MESSAGES_MAX_PAGES; i++) {
    const invoked = await invokeCindyTasks(api, { phase: "readMessages", task_id: taskId, after });
    if (!invoked.ok) return invoked;
    const page = pageItems(invoked.data);
    items.push(...page);
    if (pageHasFinal(page)) break;
    const next = pageCursor(invoked.data);
    if (!next || next === after) break;
    after = next;
  }
  return { ok: true, data: { items, messages: items } };
}

export async function invokeCindyTasks(api: CindyTasksApi, input: PluginTaskInput): Promise<{ ok: true; data: unknown } | { ok: false; errorCode: string; message: string }> {
  const { method, args } = toCindyTasksCall(input);
  try {
    const fn = api[method];
    if (typeof fn !== "function") return { ok: false, errorCode: "TASKS_FAILED", message: `${method} unavailable` };
    const data = await fn(args);
    return { ok: true, data };
  } catch (e) {
    const code = e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "TASKS_FAILED";
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, errorCode: code, message };
  }
}
