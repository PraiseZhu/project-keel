import { validPullRef } from "./dashboard.ts";

/** Read-only observations of an existing Vigil task, never a Keel graph run. */
export interface VigilProgress {
  repo: string;
  number: number;
  nodeId: string;
  sessionId: string;
  dispatchId: string;
  sourceHead: string;
  runId?: string;
  taskStatus: string;
  taskAt: number;
  superseded?: boolean;
  reason?: string;
  activity?: { op: string; at: number };
  result?: { status: string; head: string; at: number; reason?: string };
  validation?: { status: string; head: string; at: number; exitCode: number | null };
  paths: { task: string; activity: string; result?: string; validation?: string };
  notes?: { at: string; summary: string }[];
}

export interface VigilSnapshot {
  rows: VigilProgress[];
  warnings: string[];
}

export function isVigilProgress(value: unknown): value is VigilProgress {
  if (!value || typeof value !== "object") return false;
  const row = value as VigilProgress;
  const timestamp = (at: unknown) => typeof at === "number" && Number.isFinite(at) && at >= 0;
  const sha = (head: unknown) => typeof head === "string" && /^[a-f0-9]{40}$/.test(head);
  return validPullRef(row.repo, row.number) && typeof row.nodeId === "string"
    && typeof row.dispatchId === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$/.test(row.dispatchId)
    && typeof row.sessionId === "string" && /^[A-Za-z0-9:_-]{8,160}$/.test(row.sessionId)
    && sha(row.sourceHead) && typeof row.taskStatus === "string" && timestamp(row.taskAt)
    && (row.superseded === undefined || typeof row.superseded === "boolean")
    && (row.runId === undefined || typeof row.runId === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(row.runId))
    && !!row.paths && [row.paths.task, row.paths.activity].every((path) => typeof path === "string")
    && [row.paths.result, row.paths.validation].every((path) => path === undefined || typeof path === "string")
    && (!row.activity || typeof row.activity.op === "string" && timestamp(row.activity.at))
    && (!row.result || typeof row.result.status === "string" && sha(row.result.head) && timestamp(row.result.at))
    && (!row.validation || typeof row.validation.status === "string" && sha(row.validation.head) && timestamp(row.validation.at)
      && (row.validation.exitCode === null || Number.isInteger(row.validation.exitCode)))
    && (!row.notes || Array.isArray(row.notes) && row.notes.length <= 5 && row.notes.every((note) => note && typeof note.at === "string" && typeof note.summary === "string"));
}
