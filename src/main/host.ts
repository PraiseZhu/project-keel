// The slice of the `cindy` sandbox global Keel uses. Tools take a Host so tests
// can run them against fakes; production wires it to the real global in index.ts.

import type { AgentModel } from "../shared/manual/schema.ts";

export type { AgentModel };

export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body: string;
  readonly truncated?: boolean;
  /** Host-side failure detail when ok:false (e.g. credential not configured). */
  readonly message?: string;
  readonly errorCode?: string;
}

export interface NodeResponse {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly message?: string;
  readonly errorCode?: string;
}

export interface ConfirmResponse {
  readonly ok: boolean;
  readonly confirmed?: boolean;
  readonly errorCode?: string;
}

export interface FsResponse {
  readonly ok: boolean;
  readonly content?: string;
  readonly entries?: readonly { readonly name: string; readonly type?: string }[];
  readonly message?: string;
}

export interface AgentModelsResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly models: readonly AgentModel[];
}

export interface Host {
  fetch(req: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
    timeoutMs: number;
    callId?: string;
  }): Promise<FetchResponse>;
  node(method: string, params: unknown, opts?: { callId?: string; timeoutMs?: number }): Promise<NodeResponse>;
  fs(req: { op: "read" | "write" | "list" | "delete"; root: "data"; path?: string; content?: string }): Promise<FsResponse>;
  confirm(req: { body: string; confirmText?: string; cancelText?: string; danger?: boolean }): Promise<ConfirmResponse>;
  progress(callId: string): void;
  badge(unread: boolean, summary?: string): void;
  broadcast(message: unknown): void;
  requestSchedule?(req: { name: string; prompt: string; intervalMs: number }): Promise<{ ok: boolean; errorCode?: string; message?: string }>;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Sandbox GET /kv. Electron brain is read-only. */
  kvGet(): Promise<Record<string, unknown>>;
  /** Sandbox GET /agent-models. */
  agentModels(): Promise<AgentModelsResponse>;
}

export class KeelError extends Error {
  readonly code: string;
  readonly data?: Record<string, unknown>;
  constructor(code: string, message: string, data?: Record<string, unknown>) {
    super(message);
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}
