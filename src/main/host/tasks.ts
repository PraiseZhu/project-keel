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
}

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
    args: { taskId: input.task_id, limit: 50 },
  };
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
