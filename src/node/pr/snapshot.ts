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
  /** KEEL-recorded local push times (plugin data dir), never commit timestamps. */
  readonly local_pushes?: readonly { readonly repo: string; readonly head: string; readonly at_ms: number }[];
  readonly now_ms?: number;
}

export const PUSH_GRACE_MS = 2 * 60_000;

export interface CheckSuiteAppearance {
  readonly appSlug: string;
  readonly status: string;
  readonly checkRuns: number;
}

export interface NoChecksEvidence {
  readonly hasRealCheckRuns: boolean;
  readonly hasWorkflows: boolean | "query-failed";
  readonly hasRequiredProtection: boolean | "query-failed";
  readonly localPushedAtMs: number | null;
  readonly nowMs: number;
}

export type GhApiResult = { readonly code: number; readonly stdout: string; readonly stderr: string };

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
  // Only an empty rollup takes the no-checks path. Any context the rollup reported (check-run or
  // legacy commit status, pending included) is real CI and stays with upstream classifyPr; ghost
  // suites that never produced a check-run do not appear in the rollup at all.
  const evidence = row.kind === "open" && "noChecks" in row ? await collectNoChecksEvidence(repo, facts.headRefOid, facts.baseRefName, args) : null;
  const treatAsNoChecks = Boolean(evidence);
  const decision = row.kind === "closed" ? { kind: "closed" as const } : decideOpenRow(row, evidence);
  const checks =
    row.kind === "open" && !treatAsNoChecks && !("noChecks" in row)
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
    ? verificationOf(match.verifyCheck, row.kind === "open" && !treatAsNoChecks && !("noChecks" in row) ? row.ci.all : [])
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

function decodeApi(res: GhApiResult): { ok: true; value: unknown } | { notFound: true } | { failed: true } {
  if (res.code !== 0) {
    const text = `${res.stdout}\n${res.stderr}`;
    if (/404|Not Found/i.test(text)) return { notFound: true };
    try {
      const v = JSON.parse(res.stdout) as { message?: string; status?: string };
      if (v?.message === "Not Found" || v?.status === "404") return { notFound: true };
    } catch { /* fall through */ }
    return { failed: true };
  }
  try {
    return { ok: true, value: JSON.parse(res.stdout) };
  } catch {
    return { failed: true };
  }
}

/** Call-site only: suites that never produced a check-run (queued trae-ai-cn / cursor) do not count. */
export function parseCheckSuites(value: unknown): CheckSuiteAppearance[] | "query-failed" {
  if (!value || typeof value !== "object") return "query-failed";
  const list = (value as { check_suites?: unknown }).check_suites;
  if (!Array.isArray(list)) return "query-failed";
  return list.map((raw) => {
    const s = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const app = s.app && typeof s.app === "object" ? (s.app as Record<string, unknown>) : {};
    return { appSlug: String(app.slug ?? ""), status: String(s.status ?? ""), checkRuns: Number(s.latest_check_runs_count ?? 0) || 0 };
  });
}

export function parseCheckRunCount(value: unknown): number | "query-failed" {
  if (!value || typeof value !== "object") return "query-failed";
  const o = value as { total_count?: unknown; check_runs?: unknown };
  if (typeof o.total_count === "number") return o.total_count;
  if (Array.isArray(o.check_runs)) return o.check_runs.length;
  return "query-failed";
}

export function checksHaveAppeared(suites: readonly CheckSuiteAppearance[], runCount = 0): boolean {
  return runCount > 0 || suites.some((s) => s.checkRuns > 0);
}

export function appearanceFromGithub(suitesValue: unknown, runsValue: unknown): boolean | "query-failed" {
  const suites = parseCheckSuites(suitesValue);
  const runs = parseCheckRunCount(runsValue);
  if (suites === "query-failed" && runs === "query-failed") return "query-failed";
  const appeared = (suites !== "query-failed" && checksHaveAppeared(suites, 0)) || (runs !== "query-failed" && runs > 0);
  if (appeared) return true;
  if (suites !== "query-failed") return checksHaveAppeared(suites, runs === "query-failed" ? 0 : runs);
  return typeof runs === "number" && runs > 0;
}

export function workflowsFromContents(value: unknown): boolean | "query-failed" {
  if (!Array.isArray(value)) return "query-failed";
  return value.some((f) => {
    const name = f && typeof f === "object" ? String((f as { name?: unknown; path?: unknown }).name ?? (f as { path?: unknown }).path ?? "") : "";
    return /\.ya?ml$/i.test(name);
  });
}

export function requiredChecksFromProtection(value: unknown): boolean | "query-failed" {
  if (!value || typeof value !== "object") return "query-failed";
  const o = value as { contexts?: unknown; checks?: unknown };
  const contexts = Array.isArray(o.contexts) ? o.contexts.filter((x) => typeof x === "string" && x.length) : [];
  const checks = Array.isArray(o.checks) ? o.checks.filter((c) => c && typeof c === "object" && typeof (c as { context?: unknown }).context === "string") : [];
  return contexts.length > 0 || checks.length > 0;
}

export function localPushAt(pushes: SnapshotArgs["local_pushes"], repo: string, head: string | null): number | null {
  if (!pushes?.length || !head) return null;
  const hits = pushes.filter((p) => p.repo.toLowerCase() === repo.toLowerCase() && p.head === head);
  return hits.length ? Math.max(...hits.map((p) => p.at_ms)) : null;
}

async function probe(repo: string, path: string): Promise<{ ok: true; value: unknown } | { notFound: true } | { failed: true }> {
  return decodeApi(await ghRaw(["api", `repos/${repo}/${path}`], { timeoutMs: 30_000 }));
}

export async function collectNoChecksEvidence(repo: string, headSha: string | null, baseRef: string, args: Pick<SnapshotArgs, "local_pushes" | "now_ms">): Promise<NoChecksEvidence> {
  const nowMs = args.now_ms ?? Date.now();
  if (!headSha) {
    return { hasRealCheckRuns: false, hasWorkflows: "query-failed", hasRequiredProtection: "query-failed", localPushedAtMs: localPushAt(args.local_pushes, repo, headSha), nowMs };
  }
  const sha = encodeURIComponent(headSha);
  const base = encodeURIComponent(baseRef);
  const [wfRes, protRes, suitesRes, runsRes] = await Promise.all([
    probe(repo, `contents/.github/workflows?ref=${sha}`),
    probe(repo, `branches/${base}/protection/required_status_checks`),
    probe(repo, `commits/${sha}/check-suites`),
    probe(repo, `commits/${sha}/check-runs`),
  ]);
  const hasWorkflows = "failed" in wfRes ? "query-failed" as const : "notFound" in wfRes ? false : workflowsFromContents(wfRes.value);
  const hasRequiredProtection = "failed" in protRes ? "query-failed" as const : "notFound" in protRes ? false : requiredChecksFromProtection(protRes.value);
  const appearance = appearanceFromGithub(
    "ok" in suitesRes ? suitesRes.value : "failed" in suitesRes ? null : { check_suites: [] },
    "ok" in runsRes ? runsRes.value : "failed" in runsRes ? null : { total_count: 0, check_runs: [] },
  );
  return {
    hasRealCheckRuns: appearance === true,
    hasWorkflows: appearance === "query-failed" && hasWorkflows !== true ? "query-failed" : hasWorkflows,
    hasRequiredProtection: appearance === "query-failed" && hasRequiredProtection !== true ? "query-failed" : hasRequiredProtection,
    localPushedAtMs: localPushAt(args.local_pushes, repo, headSha),
    nowMs,
  };
}

/** Route an open row: an empty rollup goes to noChecksDecision (with its evidence); anything the
 *  rollup reported — check-runs or legacy commit statuses, pending included — goes to upstream classifyPr. */
export function decideOpenRow(row: T.PrSnapshot | NoChecksRow, evidence: NoChecksEvidence | null): { kind: DecisionKind; blocker?: string } {
  if ("noChecks" in row) {
    if (!evidence) return { kind: "waiting" };
    return noChecksDecision(row, evidence);
  }
  return decisionOf(classifyPr(row, false));
}

/** Same order as upstream classifyPr: conflict → threads → (no CI) → merge gate → ready.
 *  Empty check lists are not "no CI" when workflows, branch protection, a recent KEEL push, or a failed query say otherwise. */
export function noChecksDecision(row: Pick<NoChecksRow, "facts" | "threads">, evidence: NoChecksEvidence): { kind: DecisionKind; blocker?: string } {
  const f = row.facts;
  if (f.mergeable === "CONFLICTING" || f.mergeStateStatus === "DIRTY") return { kind: "blocker", blocker: "merge-conflicts" };
  if (row.threads.length) return { kind: "blocker", blocker: "review-threads" };
  if (f.isDraft) return { kind: "blocker", blocker: "draft-pr" };
  if (f.reviewDecision === "CHANGES_REQUESTED") return { kind: "blocker", blocker: "changes-requested" };
  if (f.mergeable === "UNKNOWN") return { kind: "waiting" };
  if (evidence.hasRealCheckRuns) return { kind: "waiting" };
  if (evidence.hasWorkflows === "query-failed" || evidence.hasRequiredProtection === "query-failed") return { kind: "waiting" };
  if (evidence.hasWorkflows === true || evidence.hasRequiredProtection === true) return { kind: "waiting" };
  if (evidence.localPushedAtMs !== null && evidence.nowMs - evidence.localPushedAtMs < PUSH_GRACE_MS) return { kind: "waiting" };
  return { kind: "ready" };
}
