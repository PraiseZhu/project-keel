// Map interpreter plugin_task ops onto Cindy §4.11.3 cindy.tasks.
// KEEL's electron brain calls this itself; the lead does not invoke cindy.tasks.

export type PluginTaskPhase = "create" | "send" | "getRun" | "readMessages";

export interface CindyTasksApi {
  create(args: Record<string, unknown>): Promise<unknown>;
  send(args: Record<string, unknown>): Promise<unknown>;
  getRun(args: Record<string, unknown>): Promise<unknown>;
  readMessages(args: Record<string, unknown>): Promise<unknown>;
}

export interface PluginTaskInput {
  readonly phase: PluginTaskPhase;
  readonly request_key?: string;
  readonly body?: Record<string, unknown>;
  readonly task_id?: string;
  readonly expected_revision?: string | number;
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
    return {
      method: "send",
      args: {
        taskId: input.task_id,
        expectedRevision: input.expected_revision,
        requestKey: input.request_key,
        text: input.text ?? "",
      },
    };
  }
  if (input.phase === "getRun") {
    const args: Record<string, unknown> = {};
    const runId = input.task_run_id ?? input.run_id;
    if (runId) args.runId = runId;
    if (input.request_key) args.requestKey = input.request_key;
    return { method: "getRun", args };
  }
  return {
    method: "readMessages",
    args: { taskId: input.task_id, limit: 50 },
  };
}

export async function invokeCindyTasks(api: CindyTasksApi, input: PluginTaskInput): Promise<{ ok: true; data: unknown } | { ok: false; errorCode: string; message: string }> {
  const { method, args } = toCindyTasksCall(input);
  try {
    const data = await api[method](args);
    return { ok: true, data };
  } catch (e) {
    const code = e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "TASKS_FAILED";
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, errorCode: code, message };
  }
}
