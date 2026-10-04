// Node side of fanout: read routing.json, pre-create write-lane worktrees under
// <repo>/.worktrees/pstack-<id>-<label>/, collect candidate diffs, clean up this fanout only.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { planLanes, type FanoutKind, type Tiers } from "../../shared/fanout.ts";
import type { KeelProfile } from "../../shared/types.ts";
import { ToolError, git, gitRaw } from "../env.ts";
import { assertRef, defaultBranch, repoRoot } from "../git/worktree.ts";
import { readRouting, tierOf } from "../routes/routing.ts";

const ID = /^[a-z0-9][a-z0-9-]{3,40}$/;

export function tiersFrom(data: Record<string, unknown>): Tiers {
  const review = tierOf(data, "review");
  const execute = tierOf(data, "execute");
  const whenGpt = (data.review as any)?.when_lead?.gpt ? tierOf(data, "review", "gpt-x") : null;
  const e2e = data.e2e ? tierOf(data, "e2e") : null;
  return { review, execute, reviewWhenGpt: whenGpt, e2e };
}

export async function prepare(profile: KeelProfile, p: { fanout_id: string; kind: FanoutKind; repo_dir?: string; base_ref?: string; lanes?: number; slices?: string[]; lead_model?: string | null }) {
  if (!ID.test(p.fanout_id)) throw new ToolError("INVALID_INPUT", "fanout_id 格式不对。");
  const routing = readRouting(profile.routingPath);
  const plans = planLanes(p.kind, tiersFrom(routing.data), { ...(p.lanes ? { lanes: p.lanes } : {}), ...(p.slices ? { slices: p.slices } : {}), leadModel: p.lead_model ?? null });
  const needsWrite = plans.some((l) => l.write);
  if (needsWrite && !p.repo_dir) throw new ToolError("INVALID_INPUT", `${p.kind} 有写车道，需要 repo_dir。`);
  const root = p.repo_dir ? await repoRoot(p.repo_dir) : null;
  const base = root ? assertRef(p.base_ref ?? `origin/${await defaultBranch(root)}`) : null;
  if (root && needsWrite) await gitRaw(["fetch", "origin", "--quiet"], { cwd: root, timeoutMs: 120_000 });
  const lanes = [];
  for (const l of plans) {
    let working_dir: string | null = root;
    let branch: string | null = null;
    if (l.write && root) {
      working_dir = join(root, ".worktrees", `pstack-${p.fanout_id}-${l.label}`);
      branch = `pstack/${p.fanout_id}/${l.label}`;
      if (existsSync(working_dir)) throw new ToolError("UNSAFE_TARGET", `${working_dir} 已存在。`);
      await git(["worktree", "add", "-b", branch, working_dir, base!], { cwd: root, timeoutMs: 120_000 });
    }
    lanes.push({ ...l, working_dir, branch });
  }
  return { fanout_id: p.fanout_id, kind: p.kind, base_ref: base, repo_root: root, routing: { path: routing.path, sha256: routing.sha256, updated: routing.data.updated ?? null }, lanes };
}

export async function collect(p: { repo_dir: string; lanes: { label: string; working_dir: string }[]; base_ref: string }) {
  assertRef(p.base_ref);
  const out = [];
  for (const l of p.lanes) {
    if (!existsSync(l.working_dir)) { out.push({ label: l.label, error: "worktree 不存在" }); continue; }
    await gitRaw(["add", "-A", "--intent-to-add"], { cwd: l.working_dir });
    const stat = (await gitRaw(["diff", "--stat", p.base_ref], { cwd: l.working_dir })).stdout;
    const patch = (await gitRaw(["diff", p.base_ref], { cwd: l.working_dir })).stdout;
    const head = (await gitRaw(["rev-parse", "HEAD"], { cwd: l.working_dir })).stdout.trim();
    out.push({ label: l.label, head, stat: stat.slice(0, 4000), patch: patch.slice(0, 12_000), truncated: patch.length > 12_000 });
  }
  return out;
}

export async function cleanup(p: { repo_dir: string; fanout_id: string }) {
  if (!ID.test(p.fanout_id)) throw new ToolError("INVALID_INPUT", "fanout_id 格式不对。");
  const root = await repoRoot(p.repo_dir);
  const list = await git(["worktree", "list", "--porcelain"], { cwd: root });
  const prefix = join(root, ".worktrees", `pstack-${p.fanout_id}-`);
  const removed: string[] = [];
  const kept: { path: string; reason: string }[] = [];
  for (const wt of list.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9))) {
    if (!wt.startsWith(prefix)) continue;
    const dirty = (await gitRaw(["status", "--porcelain"], { cwd: wt })).stdout.trim();
    if (dirty) { kept.push({ path: wt, reason: "有未提交改动" }); continue; }
    const r = await gitRaw(["worktree", "remove", wt], { cwd: root });
    if (r.code !== 0) { kept.push({ path: wt, reason: r.stderr.trim().slice(0, 200) }); continue; }
    removed.push(wt);
  }
  const branches = (await gitRaw(["branch", "--list", `pstack/${p.fanout_id}/*`, "--format=%(refname:short)"], { cwd: root })).stdout.split("\n").filter(Boolean);
  const branchesKept: string[] = [];
  for (const b of branches) if ((await gitRaw(["branch", "-d", b], { cwd: root })).code !== 0) branchesKept.push(b);
  await gitRaw(["worktree", "prune"], { cwd: root });
  return { removed, kept, branches_kept_unmerged: branchesKept };
}
