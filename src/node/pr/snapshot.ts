// PR snapshot: upstream watch-pr facts + classification, plus the lane's Ready gate.
// Rule files are read from the base branch on GitHub, never from the PR worktree.

import { evaluateGate, resolveLane, verificationOf } from "../../shared/lanes.ts";
import type { DecisionKind, KeelProfile, PrStatus, PrSummary, RequiredGate, Verification } from "../../shared/types.ts";
import { ToolError, ghJson, ghRaw, git } from "../env.ts";
import { withCwd } from "../context.ts";
import { ChecksUnavailable, GhGitHubReader, resolveContext } from "./upstream/github.ts";
import { classifyPr, readSnapshot } from "./upstream/policy.ts";
import type * as T from "./upstream/types.ts";
import { parsePrNumber } from "./upstream/types.ts";

export interface SnapshotArgs {
  readonly repo_dir?: string;
  /** `owner/repo`; optional when repo_dir has an origin remote. */
  readonly repo?: string;
  readonly pr?: number;
}

export async function resolvePr(args: SnapshotArgs): Promise<T.PrContext> {
  const reader = new GhGitHubReader();
  const [owner, repo] = args.repo ? args.repo.split("/") : [null, null];
  try {
    return await withCwd(args.repo_dir, () =>
      resolveContext({ reader, owner: owner ?? null, repo: repo ?? null, pr: args.pr ? parsePrNumber(args.pr) : null }),
    );
  } catch (e) {
    throw new ToolError("NO_PR", `找不到对应的 PR：${e instanceof Error ? e.message.slice(0, 200) : String(e)}。请传 pr 编号，或在有 PR 的分支目录里调用。`);
  }
}

export async function originRepo(repoDir: string): Promise<string> {
  const url = (await git(["remote", "get-url", "origin"], { cwd: repoDir })).trim();
  const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  if (!m) throw new ToolError("NO_REMOTE", `origin 不是 GitHub 仓库：${url}`);
  return `${m[1]}/${m[2]}`;
}

/** The open PR for this branch, if any. Only an empty answer means "no PR"; any query failure throws. */
export async function resolveExisting(args: SnapshotArgs): Promise<{ repo: string; number: number } | null> {
  if (!args.repo_dir) throw new ToolError("INVALID_INPUT", "需要 repo_dir 才能查当前分支的 PR。");
  const repo = await originRepo(args.repo_dir);
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: args.repo_dir })).trim();
  const rows = await ghJson<{ number: number }[]>(["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "number", "--limit", "5"], { timeoutMs: 30_000 });
  if (!Array.isArray(rows)) throw new ToolError("GH_ERROR", "gh pr list 返回的不是数组，无法确认分支是否已有 PR。");
  return rows[0] ? { repo, number: rows[0].number } : null;
}

export async function readBaseFile(repo: string, base: string, path: string): Promise<string | null> {
  const res = await ghRaw(["api", `repos/${repo}/contents/${path}?ref=${encodeURIComponent(base)}`, "-H", "Accept: application/vnd.github.raw"], { timeoutMs: 30_000 });
  return res.code === 0 ? res.stdout : null;
}

/** Required check names from base-branch rule file (`on_main ∪ pr_only`). */
export function requiredFromRuleFile(text: string | null): string[] {
  if (!text) return [];
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    const pick = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    return [...pick(data.on_main), ...pick(data.pr_only), ...pick(data.required)];
  } catch {
    return [];
  }
}

export async function requiredChecks(repo: string, pr: number): Promise<{ names: string[]; results: { name: string; bucket: string }[] }> {
  const req = await ghRaw(["pr", "checks", String(pr), "--repo", repo, "--required", "--json", "name,bucket"], { timeoutMs: 60_000 });
  const all = await ghRaw(["pr", "checks", String(pr), "--repo", repo, "--json", "name,bucket"], { timeoutMs: 60_000 });
  const parse = (s: string) => {
    try {
      return (JSON.parse(s) as { name: string; bucket: string }[]) ?? [];
    } catch {
      return [];
    }
  };
  return { names: parse(req.stdout).map((c) => c.name), results: parse(all.stdout) };
}

export function decisionOf(d: T.PrDecision): { kind: DecisionKind; blocker?: string } {
  if (d.kind === "blocker") {
    const b = d.blocker;
    return { kind: "blocker", blocker: b.kind === "merge-gate" ? b.reason : b.kind };
  }
  if (d.kind === "waiting") return { kind: "waiting" };
  if (d.kind === "merged") return { kind: "merged" };
  return { kind: "ready" };
}

const LABEL: Record<string, string> = {
  "merge-conflicts": "有合并冲突，需要 rebase",
  "review-threads": "有未解决的评审线程",
  "failing-checks": "CI 失败",
  "draft-pr": "仍是 Draft",
  "changes-requested": "评审要求修改",
  "closed-without-merge": "已关闭未合并",
};

const VERIFY_STATE: Record<Verification["state"], string> = { pass: "已通过", missing: "当前提交还没有", pending: "进行中", failing: "未通过" };

export function renderZh(s: Pick<PrStatus, "pr" | "decision" | "checks" | "unresolvedThreads" | "gate" | "preset"> & { rule?: { mergeLabel?: string }; verification?: Verification | null }): string {
  const head = `${s.pr.repo}#${s.pr.number}「${s.pr.title}」`;
  const unverified = s.verification && s.verification.state !== "pass";
  const state =
    s.decision.kind === "ready" ? (unverified ? `CI 与评审就绪，但当前提交还没有 ${s.verification!.check} 通过状态，验证前不算可合并` : s.rule?.mergeLabel && !s.pr.labels.includes(s.rule.mergeLabel) ? `就绪，待 ${s.rule.mergeLabel} 标签后才算可合并` : "可合并（请在 GitHub 合并，插件不提供合并）")
    : s.decision.kind === "merged" ? "已合并"
    : s.decision.kind === "closed" ? "已关闭"
    : s.decision.kind === "waiting" ? `等待 CI（${s.checks.pending.length} 项进行中）`
    : `阻塞：${LABEL[s.decision.blocker ?? ""] ?? s.decision.blocker}`;
  const gate = s.gate.applies ? `；Ready 门禁${s.gate.ok ? "已满足" : `未满足（缺 ${[...s.gate.missing, ...s.gate.failing, ...s.gate.pending].join("、") || "—"}）`}` : "";
  const verify = s.verification ? `；验证状态 ${s.verification.check}：${VERIFY_STATE[s.verification.state]}` : "";
  return `${head}：${state}。车道 ${s.preset}；失败 ${s.checks.failed.length} 项，通过 ${s.checks.passed} 项，未解决线程 ${s.unresolvedThreads} 条${gate}${verify}。`;
}

export async function snapshot(profile: KeelProfile, args: SnapshotArgs): Promise<Omit<PrStatus, "handedOff" | "allowedActions" | "nextAction">> {
  const context = await resolvePr(args);
  const reader = new GhGitHubReader();
  const row = await withCwd(args.repo_dir, () => readSnapshot({ reader, context, pendingHistory: "include", allowDraft: false })).catch(async (e) => {
    // A repo with no CI at all: upstream reports "checks unavailable" forever. Classify from facts alone.
    if (!(e instanceof ChecksUnavailable)) throw e;
    return noChecksRow(reader, context);
  });
  const repo = `${context.owner}/${context.repo}`;
  const meta = await ghJson<{ title: string; url: string; labels: { name: string }[] }>(["pr", "view", String(context.number), "--repo", repo, "--json", "title,url,labels"]);
  const { match, rule } = resolveLane(profile, repo);
  const facts = row.facts;
  const pr: PrSummary = {
    repo, number: context.number, url: meta.url, title: meta.title,
    state: facts.state, isDraft: facts.isDraft, headSha: facts.headRefOid, headRef: facts.headRefName, baseRef: facts.baseRefName,
    mergeable: facts.mergeable, mergeStateStatus: facts.mergeStateStatus, reviewDecision: facts.reviewDecision,
    labels: meta.labels.map((l) => l.name),
  };
  const decision = row.kind === "closed" ? { kind: "closed" as const } : "noChecks" in row ? noChecksDecision(row) : decisionOf(classifyPr(row, false));
  const checks =
    row.kind === "open" && !("noChecks" in row)
      ? { failed: row.ci.failed.map((c) => c.name), pending: row.ci.pending.map((c) => c.name), passed: row.ci.all.filter((c) => c.kind === "passed").length }
      : { failed: [], pending: [], passed: 0 };
  let gate: RequiredGate = evaluateGate(rule, [], [], []);
  if (rule.readyGate === "required-checks" && row.kind === "open") {
    const sources: string[] = ["gh pr checks --required"];
    const req = await requiredChecks(repo, context.number);
    let names = req.names;
    if (rule.baseRuleFiles?.requiredChecks) {
      const text = await readBaseFile(repo, facts.baseRefName, rule.baseRuleFiles.requiredChecks);
      names = [...names, ...requiredFromRuleFile(text)];
      sources.push(`${facts.baseRefName}:${rule.baseRuleFiles.requiredChecks}`);
    }
    gate = evaluateGate(rule, names, req.results, sources);
  }
  const unresolvedThreads = row.kind === "open" ? row.threads.length : 0;
  // A repo with no CI has no check list yet: the verify status is simply not posted.
  const verification: Verification | null = match?.verifyCheck
    ? verificationOf(match.verifyCheck, row.kind === "open" && !("noChecks" in row) ? row.ci.all : [])
    : null;
  const base = { preset: rule.preset, rule, pr, decision, checks, unresolvedThreads, gate, verification, mergeReadyLabel: pr.labels.includes("review:merge-ready") };
  return { ...base, rendered: renderZh(base) };
}

type NoChecksRow = { kind: "open"; noChecks: true; context: T.PrContext; facts: T.PullRequestFacts; threads: readonly T.ReviewThread[] };

async function noChecksRow(reader: GhGitHubReader, context: T.PrContext): Promise<NoChecksRow | Exclude<T.PrSnapshot, { kind: "open" }>> {
  const facts = await reader.pullRequest(context);
  if (facts.state === "MERGED" || facts.mergedAt !== null) return { kind: "merged", context, facts };
  if (facts.state === "CLOSED") return { kind: "closed", context, facts };
  return { kind: "open", noChecks: true, context, facts, threads: await reader.reviewThreads(context) };
}

/** Same order as upstream classifyPr: conflict → threads → (no CI) → merge gate → ready. */
export function noChecksDecision(row: Pick<NoChecksRow, "facts" | "threads">): { kind: DecisionKind; blocker?: string } {
  const f = row.facts;
  if (f.mergeable === "CONFLICTING" || f.mergeStateStatus === "DIRTY") return { kind: "blocker", blocker: "merge-conflicts" };
  if (row.threads.length) return { kind: "blocker", blocker: "review-threads" };
  if (f.isDraft) return { kind: "blocker", blocker: "draft-pr" };
  if (f.reviewDecision === "CHANGES_REQUESTED") return { kind: "blocker", blocker: "changes-requested" };
  if (f.mergeable === "UNKNOWN") return { kind: "waiting" };
  return { kind: "ready" };
}
