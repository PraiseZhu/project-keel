// Fake lead + real temp git repo for keel_* tool-surface e2e.
// Orca / gh / Jev stay on fakeHost. Local git is real under _tmp/test-runs/.
// Plugin research goes through host.tasks (cindy.tasks); the lead does not proxy it.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeContext, type ToolContext } from "../../src/main/context.ts";
import { runTool } from "../../src/main/dispatch.ts";
import type { GraphRunState, Next } from "../../src/main/graph/state.ts";
import type { CindyTasksApi } from "../../src/main/host/tasks.ts";
import { graphStatePath } from "../../src/main/store/runs.ts";
import { ToolError } from "../../src/node/env.ts";
import { changedFiles } from "../../src/node/git/files.ts";
import { contentFingerprint } from "../../src/node/git/fingerprint.ts";
import { patchId } from "../../src/node/git/patch.ts";
import { readNodeReportFile } from "../../src/node/git/report-file.ts";
import { gitState } from "../../src/node/git/worktree.ts";
import { LANE_PRESETS, EMPTY_PROFILE } from "../../src/shared/types.ts";
import { fakeHost, typesafeAnswering, type FakeHost } from "../helpers/fakeHost.ts";

export const LOOP_LIMIT = 200;
export const PR_NUMBER = 42;
export const PR_REPO = "acme/app";
export const TEAM_ID = "team-e2e";
export const SC = [{ id: "SC-1", text: "登录不再报错", verify: "npx vitest run" }] as const;
const RAN_OK = [{ cmd: "npx vitest run", exit_code: 0, tests_passed: 5 }];

const GIT_FLAGS = ["-c", "user.email=t@example.invalid", "-c", "user.name=t", "-c", "commit.gpgsign=false"];

export type ToolResult = Awaited<ReturnType<typeof runTool>>;

export interface World {
  readonly repoDir: string;
  worktree?: string;
  baseSha: string;
  /** GitHub-side PR head. May lag the local worktree. */
  prHead: string;
  syncPrHead: boolean;
  ci: "green" | "red";
  citation?: string;
  /** Uncommitted out-of-scope file at final time. */
  outOfScope: boolean;
  /** Commit an out-of-scope file after plan, before accepted. */
  outOfScopeBeforeAccepted: boolean;
  committedFix: boolean;
  workerSeq: number;
  teamId: string;
  prOpened: boolean;
}

export interface LeadOpts {
  /** null = 回执不带 team_id；缺省用 world.teamId。 */
  setupTeamId?: string | null;
  /** 回执没有 team_id 时，用 get_workspace_info.workflow_id 补。 */
  setupWorkflowId?: string;
  stopWhen?: (next: Next, state: GraphRunState, steps: Next[]) => boolean;
  beforeStep?: (next: Next, state: GraphRunState, host: FakeHost, runId: string) => void;
  gateAnswer?: (next: Extract<Next, { kind: "decide" }>) => string;
}

export interface LeadRun {
  runId: string;
  worktree?: string;
  next: Next;
  steps: Next[];
  models: { role: string; model: string }[];
  last: ToolResult;
  state: GraphRunState;
}

const dirs: string[] = [];

export function cleanupRepos(): void {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...GIT_FLAGS, ...args], { cwd, stdio: "pipe" }).toString();
}

export function makeRepo(): { dir: string; sha: () => string } {
  mkdirSync("_tmp/test-runs", { recursive: true });
  const dir = mkdtempSync(resolve("_tmp/test-runs/e2e-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/app.ts"), "export const ok = false;\n");
  writeFileSync(join(dir, "README.md"), "app\n");
  writeFileSync(join(dir, ".gitignore"), ".keel/\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "remote", "add", "origin", `https://github.com/${PR_REPO}.git`);
  return { dir, sha: () => git(dir, "rev-parse", "HEAD").trim() };
}

export function addWorktree(root: string, name: string): string {
  mkdirSync(join(root, ".worktrees"), { recursive: true });
  const path = join(root, ".worktrees", name);
  git(root, "worktree", "add", "-q", "-b", `keel/${name}`, path, "HEAD");
  return path;
}

function prSnapshot(world: World) {
  const gate = { applies: false, required: [] as string[], passed: [] as string[], failing: [] as string[], pending: [] as string[], missing: [] as string[], ok: true, sources: [] as string[] };
  const green = world.ci === "green";
  return {
    preset: "personal" as const,
    rule: LANE_PRESETS.personal,
    pr: {
      repo: PR_REPO,
      number: PR_NUMBER,
      url: `https://github.com/${PR_REPO}/pull/${PR_NUMBER}`,
      title: "fix login",
      state: "OPEN" as const,
      isDraft: false,
      headSha: world.prHead,
      headRef: "keel/e2e",
      baseRef: "main",
      mergeable: green ? "MERGEABLE" : "UNSTABLE",
      mergeStateStatus: green ? "CLEAN" : "UNSTABLE",
      reviewDecision: "APPROVED",
      labels: [] as string[],
    },
    decision: green
      ? { kind: "ready" as const }
      : { kind: "blocker" as const, blocker: "failing-checks" },
    checks: green
      ? { failed: [] as string[], pending: [] as string[], passed: 1 }
      : { failed: ["ci"], pending: [] as string[], passed: 0 },
    unresolvedThreads: 0,
    gate,
    verification: null,
    mergeReadyLabel: false,
    rendered: `${PR_REPO}#${PR_NUMBER}`,
  };
}

async function nodeOk<T>(fn: () => Promise<T> | T): Promise<{ ok: true; result: T } | { ok: false; message: string }> {
  try {
    return { ok: true, result: await fn() };
  } catch (e) {
    if (e instanceof ToolError) return { ok: false, message: `${e.code}: ${e.message}` };
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

function mergeBase(repoDir: string, baseRef: string, fallback: string): string {
  try {
    return git(repoDir, "merge-base", baseRef, "HEAD").trim();
  } catch {
    return fallback;
  }
}

function fakeTasks(): CindyTasksApi {
  let n = 0;
  return {
    async create() {
      n += 1;
      return { taskId: `task-${n}`, revision: 1 };
    },
    async send() {
      return { runId: `trun-${n || 1}`, revision: 2 };
    },
    async getRun() {
      return { ok: true, taskId: `task-${n || 1}`, revision: 1, status: "running" };
    },
    async readMessages() {
      return { messages: [] };
    },
  };
}

export function makeWorld(over: Partial<World> = {}): World {
  const repo = makeRepo();
  return {
    repoDir: repo.dir,
    baseSha: repo.sha(),
    prHead: repo.sha(),
    syncPrHead: true,
    ci: "green",
    outOfScope: false,
    outOfScopeBeforeAccepted: false,
    committedFix: false,
    workerSeq: 0,
    teamId: TEAM_ID,
    prOpened: false,
    ...over,
  };
}

export function makeE2eHost(world: World): FakeHost {
  return fakeHost({
    fetch: typesafeAnswering(0.9),
    tasks: fakeTasks(),
    node: async (method: string, params: Record<string, unknown>) => {
      if (method === "git/state") return nodeOk(() => gitState(String(params.repo_dir)));
      if (method === "git/content-fingerprint") return nodeOk(() => contentFingerprint({ repo_dir: String(params.repo_dir) }));
      if (method === "git/changed-files") return nodeOk(() => changedFiles({ repo_dir: String(params.repo_dir), ...(typeof params.base === "string" ? { base: params.base } : {}) }));
      if (method === "git/patch-id") {
        return nodeOk(() => patchId({
          repo_dir: String(params.repo_dir),
          base_sha: typeof params.base_sha === "string" ? params.base_sha : undefined,
          head_sha: typeof params.head_sha === "string" ? params.head_sha : undefined,
        }));
      }
      if (method === "git/base-sha") {
        const dir = String(params.repo_dir);
        const baseRef = typeof params.base_ref === "string" && params.base_ref ? params.base_ref.replace(/^origin\//, "") : "main";
        return { ok: true, result: { base_ref: baseRef, base_sha: mergeBase(dir, baseRef, world.baseSha), fetched: false } };
      }
      if (method === "worktree/create") {
        return nodeOk(() => {
          const path = addWorktree(world.repoDir, String(params.name));
          world.worktree = path;
          return { path };
        });
      }
      if (method === "report/read") {
        return nodeOk(() => readNodeReportFile({
          worktree: String(params.worktree),
          node: String(params.node),
          attempt: Number(params.attempt),
        }));
      }
      if (method === "pr/open") {
        world.prOpened = true;
        if (world.syncPrHead) {
          const dir = typeof params.repo_dir === "string" ? params.repo_dir : (world.worktree ?? world.repoDir);
          try { world.prHead = git(dir, "rev-parse", "HEAD").trim(); } catch { /* keep frozen head */ }
        }
        return {
          ok: true,
          result: {
            url: `https://github.com/${PR_REPO}/pull/${PR_NUMBER}`,
            number: PR_NUMBER,
            repo: PR_REPO,
            head_sha: world.prHead,
          },
        };
      }
      if (method === "pr/resolve") {
        if (!world.prOpened) return { ok: true, result: null };
        return { ok: true, result: { repo: PR_REPO, number: PR_NUMBER } };
      }
      if (method === "pr/snapshot") return { ok: true, result: prSnapshot(world) };
      if (method === "pr/threads") return { ok: true, result: { threads: [] } };
      return { ok: false, message: `UNEXPECTED ${method}` };
    },
  });
}

export function ctxOf(host: FakeHost, callId: string): ToolContext {
  return makeContext(host, callId, EMPTY_PROFILE);
}

export function readGraph(host: FakeHost, runId: string): GraphRunState {
  const raw = host.files.get(graphStatePath(runId));
  if (!raw) throw new Error(`missing graph-state for ${runId}`);
  return JSON.parse(raw) as GraphRunState;
}

function localHead(world: World): string {
  const dir = world.worktree ?? world.repoDir;
  return git(dir, "rev-parse", "HEAD").trim();
}

function commitFix(world: World): void {
  const dir = world.worktree ?? world.repoDir;
  writeFileSync(join(dir, "src/app.ts"), "export const ok = true;\n");
  git(dir, "add", "src/app.ts");
  git(dir, "commit", "-q", "-m", "fix login");
  world.committedFix = true;
  if (world.syncPrHead) world.prHead = git(dir, "rev-parse", "HEAD").trim();
}

function writeOutOfScope(world: World): void {
  const dir = world.worktree ?? world.repoDir;
  writeFileSync(join(dir, "outside.txt"), "leaked\n");
}

function commitOutOfScope(world: World): void {
  const dir = world.worktree ?? world.repoDir;
  writeFileSync(join(dir, "outside.txt"), "leaked\n");
  git(dir, "add", "outside.txt");
  git(dir, "commit", "-q", "-m", "leak outside scope");
}

function inlineReport(next: Extract<Next, { kind: "dispatch" }>, world: World): Record<string, unknown> {
  const role = next.create_worker?.role;
  const head = world.worktree ? localHead(world) : world.prHead;
  const report: Record<string, unknown> = {
    status: "done",
    summary: `${role ?? "node"} 完成`,
    files_changed: role === "keel-worker" ? ["src/app.ts"] : [],
    ran: role === "keel-verifier" || role === "keel-worker" ? RAN_OK : [],
    sc_evidence: { "SC-1": true },
  };
  if (world.citation) report.citation = world.citation;
  if (role === "keel-verifier" || role === "keel-architect" || role === "keel-worker") {
    report.head_sha = head;
  }
  if (role === "keel-verifier" || role === "keel-architect") report.verdict = "PASS";
  return report;
}

function pluginFinalReport(world: World): Record<string, unknown> {
  return {
    status: "done",
    summary: "research 完成",
    files_changed: [],
    ran: [],
    sc_evidence: { "SC-1": true },
    ...(world.citation ? { citation: world.citation } : {}),
  };
}

async function call(ctx: ToolContext, tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  return runTool(ctx, tool, args);
}

function nextOf(r: ToolResult): Next {
  if (!r.ok) throw new Error(`tool failed ${r.errorCode}: ${r.message}`);
  const n = (r.result as { next?: Next }).next;
  if (!n) throw new Error("missing next");
  return n;
}

function inflightPlugin(state: GraphRunState): { key: string } | undefined {
  for (const n of Object.values(state.nodes)) {
    if (n.task && n.dispatch_key && n.dispatch_state !== "terminal" && n.dispatch_state !== "reported") {
      return { key: n.dispatch_key };
    }
  }
  return undefined;
}

export async function leadLoop(host: FakeHost, started: { run_id: string; next: Next; worktree?: string }, world: World, opts: LeadOpts = {}): Promise<LeadRun> {
  const runId = started.run_id;
  let next = started.next;
  const steps: Next[] = [];
  const models: { role: string; model: string }[] = [];
  let pending: Extract<Next, { kind: "dispatch" }> | undefined;
  let last: ToolResult = { ok: true, result: started };
  let seq = 0;

  for (let i = 0; i < LOOP_LIMIT; i++) {
    steps.push(next);
    const state = readGraph(host, runId);
    if (next.kind === "done" || next.kind === "stop") {
      return { runId, worktree: started.worktree ?? world.worktree, next, steps, models, last, state };
    }
    if (opts.stopWhen?.(next, state, steps)) {
      return { runId, worktree: started.worktree ?? world.worktree, next, steps, models, last, state };
    }
    opts.beforeStep?.(next, state, host, runId);
    const c = ctxOf(host, `e2e-${++seq}`);

    if (next.kind === "setup") {
      const outcome: Record<string, unknown> = { worker_permission_mode: "bypassPermissions" };
      if (opts.setupTeamId === null) {
        // 回执故意不带 team_id
      } else {
        outcome.team_id = opts.setupTeamId ?? world.teamId;
      }
      const setupArgs: Record<string, unknown> = {
        run_id: runId,
        phase: "setup",
        outcome,
        session_id: "sol-e2e",
      };
      if (!outcome.team_id && opts.setupWorkflowId) {
        setupArgs.get_workspace_info = { workflow_id: opts.setupWorkflowId };
      }
      last = await call(c, "keel_report", setupArgs);
      next = nextOf(last);
      continue;
    }

    if (next.kind === "dispatch") {
      if (next.plugin_task) {
        throw new Error(`产品缺陷：假主控看到 plugin_task dispatch（${next.plugin_task.phase}），应在 host.tasks 内完成`);
      }
      pending = next;
      if (next.create_worker) {
        models.push({ role: next.create_worker.role, model: next.create_worker.model });
        if (next.create_worker.role === "keel-worker" && world.outOfScopeBeforeAccepted) {
          commitOutOfScope(world);
        }
      }
      world.workerSeq += 1;
      const accepted: Record<string, unknown> = {
        run_id: runId,
        phase: "accepted",
        dispatch_key: next.dispatch_key,
        worker_id: `w-${world.workerSeq}`,
        worker_session_id: `ws-${world.workerSeq}`,
        dispatch_outcome: { dispatched: true, wakeKind: "immediate" },
      };
      last = await call(c, "keel_report", accepted);
      next = nextOf(last);
      continue;
    }

    if (next.kind === "wait") {
      if (pending) {
        if (pending.create_worker?.role === "keel-worker") {
          if (world.outOfScope) writeOutOfScope(world);
          else if (!world.committedFix && !world.outOfScopeBeforeAccepted) commitFix(world);
        }
        last = await call(c, "keel_report", {
          run_id: runId,
          phase: "final",
          dispatch_key: pending.dispatch_key,
          inline_report: inlineReport(pending, world),
        });
        pending = undefined;
        if (!last.ok) {
          return { runId, worktree: started.worktree ?? world.worktree, next, steps, models, last, state: readGraph(host, runId) };
        }
        next = nextOf(last);
        continue;
      }
      const plugin = inflightPlugin(state);
      if (plugin) {
        last = await call(c, "keel_report", {
          run_id: runId,
          phase: "final",
          dispatch_key: plugin.key,
          inline_report: pluginFinalReport(world),
        });
        if (!last.ok) {
          return { runId, worktree: started.worktree ?? world.worktree, next, steps, models, last, state: readGraph(host, runId) };
        }
        next = nextOf(last);
        continue;
      }
      if (next.call.tool === "pr_open") {
        const openArgs = { ...next.call.args, sections: "e2e sim", authorization_source: "用户 2026-10-04：提交 PR", run_id: runId };
        last = await call(c, "pr_open", openArgs);
        if (!last.ok) {
          return { runId, worktree: started.worktree ?? world.worktree, next, steps, models, last, state: readGraph(host, runId) };
        }
        last = await call(c, "keel_wait", { run_id: runId, max_minutes: 15 });
        next = nextOf(last);
        continue;
      }
      last = await call(c, "keel_wait", { run_id: runId, max_minutes: 15 });
      next = nextOf(last);
      continue;
    }

    if (next.kind === "reconcile") {
      const rec = next;
      const teamId = state.team?.team_id ?? world.teamId;
      const node = Object.values(state.nodes).find((n) => n.dispatch_key === rec.dispatch_key);
      last = await call(c, "keel_report", {
        run_id: runId,
        phase: "reconcile",
        dispatch_key: rec.dispatch_key,
        queries_result: {
          list_workers: {
            ok: true,
            complete: true,
            team_id: teamId,
            workers: [{
              label: node?.worker_label ?? "keel-e2e",
              worker_id: node?.worker_id ?? "w-live",
              worker_session_id: node?.worker_session_id ?? "ws-live",
              status: "running",
            }],
          },
          get_worker_queue_status: { ok: true, pending: [], consuming: null },
          getRun: { ok: true, complete: true, status: "running" },
          readMessages: { ok: true, complete: true },
        },
      });
      next = nextOf(last);
      continue;
    }

    if (next.kind === "recover") {
      const rec = next;
      const teamId = state.team?.team_id ?? world.teamId;
      const list = { ok: true, complete: true, team_id: teamId, workers: [] as unknown[] };
      last = await call(c, "keel_report", {
        run_id: runId,
        phase: "recover",
        dispatch_key: rec.dispatch_key,
        action: rec.action,
        action_result: rec.action === "verify_stopped"
          ? { ok: true, complete: true, team_id: teamId, list_workers: list, worker_status: { ok: true, complete: true, status: "idle" } }
          : { ok: true, complete: true, team_id: teamId, list_workers: list },
      });
      next = nextOf(last);
      continue;
    }

    if (next.kind === "decide") {
      const rec = next;
      if (rec.gate_id === "human:reconcile" && /不自动补投|队列为空/.test(rec.question)) {
        return { runId, worktree: started.worktree ?? world.worktree, next: rec, steps, models, last, state };
      }
      const answer = opts.gateAnswer?.(rec) ?? rec.options[0]!;
      last = await call(c, "keel_gate", { run_id: runId, gate_id: rec.gate_id, answer });
      next = nextOf(last);
      continue;
    }

    throw new Error(`unhandled next.kind ${(next as Next).kind}`);
  }
  throw new Error(`lead loop hit ${LOOP_LIMIT} steps; last=${JSON.stringify(steps.slice(-8).map((s) => s.kind))}`);
}

export async function startRun(host: FakeHost, args: Record<string, unknown>): Promise<{ run_id: string; next: Next; worktree?: string }> {
  const r = await runTool(ctxOf(host, "e2e-start"), "keel_run", args);
  if (!r.ok) throw new Error(`keel_run failed ${r.errorCode}: ${r.message}`);
  const result = r.result as { run_id: string; next: Next; worktree?: string };
  return result;
}
