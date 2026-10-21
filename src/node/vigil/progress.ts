import { createHash } from "node:crypto";
import { open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { validPullRef } from "../../shared/dashboard.ts";
import type { VigilProgress, VigilSnapshot } from "../../shared/vigil.ts";
import { ToolError } from "../env.ts";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const text = (value: unknown, limit = 800): string => typeof value === "string" ? value.slice(0, limit) : "";
const stamp = (value: unknown): number => typeof value === "string" ? Date.parse(value) || 0 : 0;
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const name = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$/.test(value);
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

async function checkedPath(root: string, path: string): Promise<string> {
  const resolved = await realpath(path);
  if (!within(root, resolved)) throw new Error("记录路径越出配置的 Vigil 运行目录");
  return resolved;
}

/** Bound all file reads, and follow only links that stay inside the configured home. */
async function read(root: string, path: string, optional = false): Promise<{ value: RecordValue; bytes: Buffer } | undefined> {
  try {
    const handle = await open(await checkedPath(root, path), "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("记录不是普通文件或超过 1 MiB");
      const bytes = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > stat.size) throw new Error("读取期间记录变大，请稍后重试");
      const content = bytes.subarray(0, bytesRead);
      return { value: record(JSON.parse(content.toString("utf8"))), bytes: content };
    } finally { await handle.close(); }
  } catch (error) { if (optional && missing(error)) return undefined; throw error; }
}

function sameIdentity(value: RecordValue, task: RecordValue, sessionId: string): boolean {
  return ["dispatchId", "nodeId", "number", "repo"].every((key) => value[key] === task[key]) && value.sessionId === sessionId;
}

async function resultFor(root: string, task: RecordValue, sessionId: string): Promise<VigilProgress["result"]> {
  const file = await read(root, join(root, "state/results", `${task.dispatchId}.json`), true);
  if (!file) return undefined;
  const row = file.value;
  if (row.schemaVersion !== 2 || row.kind !== "mivo-repair-result" || !sameIdentity(row, task, sessionId)
    || row.sourceHead !== task.headRefOid || !sha(row.head) || !stamp(row.observedAt)) throw new Error("修复结果与当前任务不匹配");
  return { status: text(row.status), head: row.head, at: stamp(row.observedAt), ...(row.reason ? { reason: text(row.reason) } : {}) };
}

async function validationFor(root: string, task: RecordValue, sessionId: string): Promise<{ value: NonNullable<VigilProgress["validation"]>; path: string } | undefined> {
  const dir = join(root, "state/validations", String(task.dispatchId));
  let files: string[];
  try { files = (await readdir(await checkedPath(root, dir))).filter((file) => /^[a-f0-9]{40}\.json$/.test(file)); }
  catch (error) { if (missing(error)) return undefined; throw error; }
  if (files.length > 128) throw new Error("本任务的验证指针超过读取上限");
  let latest: { value: NonNullable<VigilProgress["validation"]>; path: string } | undefined;
  for (const file of files) {
    const pointer = (await read(root, join(dir, file)))!.value;
    if (!sha(pointer.head) || pointer.head !== file.slice(0, -5) || typeof pointer.receiptPath !== "string"
      || !isAbsolute(pointer.receiptPath) || !within(dir, pointer.receiptPath)) throw new Error("验证指针不属于当前任务");
    const receipt = (await read(root, pointer.receiptPath))!;
    const row = receipt.value;
    if (createHash("sha256").update(receipt.bytes).digest("hex") !== pointer.receiptSha256
      || !sameIdentity(row, task, sessionId) || row.schemaVersion !== 2 || row.kind !== "mivo-repair-validation"
      || row.head !== pointer.head || row.status !== pointer.status || !stamp(row.finishedAt)) throw new Error("验证回执身份或摘要校验失败");
    if (row.status === "pass" && row.exitCode !== 0) throw new Error("验证通过记录缺少成功退出码");
    const value = { status: text(row.status), head: pointer.head, at: stamp(row.finishedAt), exitCode: typeof row.exitCode === "number" ? row.exitCode : null };
    if (!latest || value.at > latest.value.at) latest = { value, path: pointer.receiptPath };
  }
  return latest;
}

async function progressFor(root: string, file: string, repo: string): Promise<VigilProgress | undefined> {
  const entry = (await read(root, join(root, "state/prs", file)))!.value;
  const active = record(entry.activeTask);
  if (!active.dispatchId) return undefined;
  const sessionId = text(entry.sessionId);
  if (!name(active.dispatchId) || !/^[A-Za-z0-9:_-]{8,160}$/.test(sessionId) || (active.sessionId && active.sessionId !== sessionId)) throw new Error("任务或会话绑定无效");
  const taskPath = join(root, "state/tasks", `${active.dispatchId}.json`);
  const task = (await read(root, taskPath))!.value;
  if (task.dispatchId !== active.dispatchId || task.nodeId !== entry.nodeId || file !== `${entry.nodeId}.json`
    || task.number !== entry.number || task.repo !== repo || !validPullRef(task.repo, task.number)
    || !sha(task.headRefOid) || (active.head && active.head !== task.headRefOid)) throw new Error("PR 身份与活动任务不匹配");
  const activityPath = join(root, "state/activity", `${active.dispatchId}.json`);
  const activity = (await read(root, activityPath, true))?.value;
  if (activity && (activity.dispatchId !== task.dispatchId || !stamp(activity.at))) throw new Error("活动记录与当前任务不匹配");
  const result = await resultFor(root, task, sessionId);
  const verification = await validationFor(root, task, sessionId);
  const currentHandoff = record(entry.handoff).id;
  const taskHandoff = record(task.handoff).id;
  const superseded = ["superseded", "invalidated"].includes(text(active.status)) || Boolean(currentHandoff && taskHandoff && currentHandoff !== taskHandoff)
    || Boolean(entry.releaseEpoch && task.releaseEpoch && entry.releaseEpoch !== task.releaseEpoch);
  return {
    repo, number: Number(task.number), nodeId: String(task.nodeId), sessionId, dispatchId: active.dispatchId, sourceHead: task.headRefOid,
    ...(typeof task.keelRunId === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(task.keelRunId) ? { runId: task.keelRunId } : {}),
    taskStatus: text(active.status), taskAt: stamp(active.observedAt ?? active.at ?? task.createdAt), ...(superseded ? { superseded: true } : {}), ...(active.reason ? { reason: text(active.reason) } : {}),
    ...(activity ? { activity: { op: text(activity.op, 80), at: stamp(activity.at) } } : {}), ...(result ? { result } : {}),
    ...(verification ? { validation: verification.value } : {}),
    paths: { task: taskPath, activity: activityPath, ...(result ? { result: join(root, "state/results", `${active.dispatchId}.json`) } : {}), ...(verification ? { validation: verification.path } : {}) },
  };
}

async function readHome(home: string, snapshot: VigilSnapshot): Promise<void> {
  if (!isAbsolute(home)) throw new Error("Vigil 运行目录必须是绝对路径");
  const root = await realpath(home);
  const profile = (await read(root, join(root, "config/profile.json")))!.value;
  if (!validPullRef(profile.targetRepo, 1)) throw new Error("Vigil 配置缺少有效 targetRepo");
  const files = (await readdir(await checkedPath(root, join(root, "state/prs")))).filter((file) => /^[A-Za-z0-9_-]+\.json$/.test(file));
  if (files.length > 2000) throw new Error("Vigil PR 记录超过读取上限");
  for (const file of files) {
    try { const row = await progressFor(root, file, profile.targetRepo); if (row) snapshot.rows.push(row); }
    catch { snapshot.warnings.push(`Vigil 任务记录 ${file} 暂不可读或绑定无效，未推断其进度。`); }
  }
}

/** Configured homes only; never writes, executes watcher commands, or starts sessions. */
export async function vigilProgress(homes: unknown): Promise<VigilSnapshot> {
  if (homes === undefined) return { rows: [], warnings: [] };
  if (!Array.isArray(homes) || homes.length > 16 || homes.some((home) => typeof home !== "string" || home.length > 4096))
    throw new ToolError("VIGIL_CONFIG_INVALID", "vigilHomes 必须是最多 16 个运行目录的数组。");
  const snapshot: VigilSnapshot = { rows: [], warnings: [] };
  for (const home of new Set(homes as string[])) {
    try { await readHome(home, snapshot); }
    catch { snapshot.warnings.push("无法读取配置的 Vigil 运行目录，请检查目录及读取权限。"); }
  }
  return snapshot;
}
