// Tool-layer wrapper: same resolve as shared, but failures are KeelError (code + data.path).

import { KeelError } from "../host.ts";
import { ManualError, type Harness, type ModelManual, type Role, type TaskType } from "../../shared/manual/schema.ts";
import {
  findProfile as findProfileShared,
  resolve as resolveShared,
  resolveProfileForHarness as resolveProfileForHarnessShared,
  type ResolvedRoutes,
} from "../../shared/manual/resolve.ts";

export type { ResolvedRoutes };

function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ManualError) throw new KeelError(e.code, e.message, { path: e.path });
    throw e;
  }
}

export function resolve(manual: ModelManual, profileId: string, taskType: TaskType, role: Role): ResolvedRoutes {
  return wrap(() => resolveShared(manual, profileId, taskType, role));
}

export function resolveProfileForHarness(manual: ModelManual, harness: Harness) {
  return wrap(() => resolveProfileForHarnessShared(manual, harness));
}

export function findProfile(manual: ModelManual, profileId: string) {
  return wrap(() => findProfileShared(manual, profileId));
}
