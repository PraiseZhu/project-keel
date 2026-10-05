// PR write actions. Every mutation here is gated upstream in main.js (authorization
// source, lane handoff, cindy.confirm). Merging is intentionally absent: Keel never merges.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draftFor, resolveLane } from "../../shared/lanes.ts";
import type { KeelProfile, Verification } from "../../shared/types.ts";
import { ToolError, gh, ghJson, git, gitRaw } from "../env.ts";
import { withCwd } from "../context.ts";
import { originRepo, readBaseFile, resolvePr, snapshot } from "./snapshot.ts";
import { GhGitHubReader } from "./upstream/github.ts";


/** Write a JSON body to a private temp file and hand it to `gh api --input`; never via argv or a shell. */
async function ghApiInput(args: string[], body: unknown): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "keel-"));
  const file = join(dir, "body.json");
  try {
    writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
    return await gh(["api", ...args, "--input", file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function titleTypesFrom(text: string | null): string[] {
  if (!text) return [];
  try {
    const d = JSON.parse(text) as { titleTypes?: unknown };
    return Array.isArray(d.titleTypes) ? d.titleTypes.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function validateTitle(title: string, types: readonly string[]): string | null {
  if (!title.trim()) return "标题不能为空。";
  if (!types.length) return null;
  const m = title.match(/^([a-z]+)(\([^)]+\))?!?:\s+\S/);
  if (!m || !types.includes(m[1]!)) return `标题须为 \`<type>: 描述\`，type 取自 base 规则：${types.join(" / ")}。`;
  return null;
}

export function renderBody(sections: Record<string, string> | string): string {
  if (typeof sections === "string") return sections;
  return Object.entries(sections).map(([h, b]) => `## ${h}\n\n${b.trim()}\n`).join("\n");
}

export async function prOpen(profile: KeelProfile, p: { repo_dir: string; title: string; sections: Record<string, string> | string; base?: string; draft?: boolean; push?: boolean }) {
  const repo = await originRepo(p.repo_dir);
  const { rule, match } = resolveLane(profile, repo);
  const base = p.base ?? (await ghJson<{ defaultBranchRef: { name: string } }>(["repo", "view", repo, "--json", "defaultBranchRef"])).defaultBranchRef.name;
  if (rule.baseRuleFiles?.prRules) {
    const problem = validateTitle(p.title, titleTypesFrom(await readBaseFile(repo, base, rule.baseRuleFiles.prRules)));
    if (problem) throw new ToolError("TITLE_INVALID", problem);
  }
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: p.repo_dir })).trim();
  if (branch === base || branch === "HEAD") throw new ToolError("LANE_RULE", `当前在 ${branch}，不能从默认分支开 PR。请先建功能分支。`);
  if (p.push) await git(["push", "-u", "origin", branch], { cwd: p.repo_dir, timeoutMs: 120_000 });
  const upstream = await gitRaw(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { cwd: p.repo_dir });
  if (upstream.code !== 0) throw new ToolError("NOT_PUSHED", `分支 ${branch} 还没推送到远端。传 push:true 并附授权来源，或先手动推送。`);
  const ahead = (await git(["rev-list", "--count", "@{u}..HEAD"], { cwd: p.repo_dir })).trim();
  if (ahead !== "0") throw new ToolError("NOT_PUSHED", `本地比远端多 ${ahead} 个提交，请先推送。`);
  const { draft, forced } = draftFor(rule, p.draft);
  const args = ["pr", "create", "--repo", repo, "--base", base, "--head", branch, "--title", p.title, "--body", renderBody(p.sections)];
  if (draft) args.push("--draft");
  const url = (await gh(args, { cwd: p.repo_dir, timeoutMs: 60_000 })).trim().split("\n").pop() ?? "";
  const number = Number(url.match(/\/pull\/(\d+)/)?.[1] ?? 0);
  return { url, number, draft, draft_forced_by_lane: forced, preset: rule.preset, preflight: match?.preflight ?? null };
}

/** Ready needs the lane gate, every check green, and nothing ahead of the Draft flag. */
export function readyVerdict(s: Pick<Awaited<ReturnType<typeof snapshot>>, "gate" | "decision" | "checks"> & { verification?: Verification | null }): { passed: boolean; missing: string[] } {
  const gate = s.gate;
  const missing = gate.applies ? [...gate.missing, ...gate.failing.map((n) => `${n}（失败）`), ...gate.pending.map((n) => `${n}（进行中）`)] : [];
  // Required checks alone are not "CI green": the upstream classifier must see nothing ahead
  // of the Draft flag (conflicts, threads, failing CI) and no check may still be running.
  const blockerOk = s.decision.kind === "ready" || (s.decision.kind === "blocker" && s.decision.blocker === "draft-pr");
  if (!blockerOk) missing.push(`PR 状态未就绪（${s.decision.kind === "blocker" ? s.decision.blocker : s.decision.kind}）`);
  for (const n of s.checks.failed) if (!missing.includes(`${n}（失败）`)) missing.push(`${n}（失败）`);
  for (const n of s.checks.pending) if (!missing.includes(`${n}（进行中）`)) missing.push(`${n}（进行中）`);
  const verified = !s.verification || s.verification.state === "pass";
  if (!verified && !missing.some((m) => m.startsWith(`${s.verification!.check}（`))) missing.push(`${s.verification!.check}（当前提交未验证）`);
  return { passed: (!gate.applies || gate.ok) && blockerOk && verified && s.checks.failed.length === 0 && s.checks.pending.length === 0, missing };
}

export async function prReady(profile: KeelProfile, p: { repo_dir?: string; repo?: string; pr?: number; dry_run?: boolean; expected_head?: string | null }) {
  const s = await snapshot(profile, p);
  // The caller checked its evidence against one head; if the PR moved since, that evidence is stale.
  if (p.expected_head && s.pr.headSha !== p.expected_head) throw new ToolError("HEAD_MOVED", "评估门禁后 PR head 有新提交，进场证据与门禁都要按新 head 重新核对后再调用 pr_ready。");
  const gate = s.gate;
  const { passed, missing } = readyVerdict(s);
  const base = { gate: { passed, missing, required: gate.required, sources: gate.sources }, pr: s.pr, preset: s.preset, head_sha: s.pr.headSha };
  if (!passed) return { ...base, ready: false, executed: false };
  if (p.dry_run) return { ...base, ready: s.pr.isDraft ? false : true, executed: false, would_mark_ready: s.pr.isDraft };
  // Re-read head right before acting: if it moved, the gate result is stale.
  const fresh = await ghJson<{ headRefOid: string; isDraft: boolean }>(["pr", "view", String(s.pr.number), "--repo", s.pr.repo, "--json", "headRefOid,isDraft"]);
  if (fresh.headRefOid !== s.pr.headSha) throw new ToolError("HEAD_MOVED", "评估门禁后 PR head 有新提交，请重新调用 pr_ready。");
  if (fresh.isDraft) await gh(["pr", "ready", String(s.pr.number), "--repo", s.pr.repo]);
  return { ...base, ready: true, executed: fresh.isDraft };
}

export async function prThreads(profile: KeelProfile, p: { repo_dir?: string; repo?: string; pr?: number }) {
  const ctx = await resolvePr(p);
  const threads = await withCwd(p.repo_dir, () => new GhGitHubReader().reviewThreads(ctx));
  void profile;
  return {
    repo: `${ctx.owner}/${ctx.repo}`,
    number: ctx.number,
    threads: threads.map((t) => ({ id: t.id, author: t.firstComment?.authorLogin ?? null, path: t.firstComment?.path ?? null, line: t.firstComment?.line ?? null, body: (t.firstComment?.body ?? "").slice(0, 4000), is_bot: t.isBugbot })),
  };
}

export async function prReply(p: { repo: string; pr: number; target_id: string; body: string; resolve?: boolean }) {
  if (p.target_id.startsWith("PRRT_")) {
    const reply = await ghApiInput(["graphql"], {
      query: "mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{url}}}",
      variables: { id: p.target_id, body: p.body },
    });
    const url = (JSON.parse(reply) as any)?.data?.addPullRequestReviewThreadReply?.comment?.url ?? null;
    if (p.resolve)
      await ghApiInput(["graphql"], { query: "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}", variables: { id: p.target_id } });
    return { posted: true, url, resolved: Boolean(p.resolve) };
  }
  if (p.target_id !== "issue") throw new ToolError("INVALID_INPUT", "target_id 须为评审线程 id（PRRT_ 开头）或 \"issue\"（PR 主讨论区）。");
  const out = await ghApiInput([`repos/${p.repo}/issues/${p.pr}/comments`, "--method", "POST"], { body: p.body });
  return { posted: true, url: (JSON.parse(out) as { html_url?: string }).html_url ?? null, resolved: false };
}

export async function prBoard(profile: KeelProfile, p: { repos?: string[] }) {
  const repos = p.repos?.length ? p.repos : profile.boardRepos;
  const args = ["search", "prs", "--author", "@me", "--state", "open", "--json", "repository,number,title,url,isDraft,updatedAt", "--limit", "50"];
  for (const r of repos) args.push("--repo", r);
  const rows = await ghJson<{ repository: { nameWithOwner: string }; number: number; title: string; url: string; isDraft: boolean; updatedAt: string }[]>(args, { timeoutMs: 60_000 });
  return rows.map((r) => ({ repo: r.repository.nameWithOwner, number: r.number, title: r.title, url: r.url, isDraft: r.isDraft, updatedAt: r.updatedAt, preset: resolveLane(profile, r.repository.nameWithOwner).rule.preset }));
}
