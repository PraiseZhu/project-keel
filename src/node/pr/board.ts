import { pullKey, pullUrl, validPullRef, type BoardScope, type PullPage, type RemotePull } from "../../shared/dashboard.ts";
import { ghJson, ToolError } from "../env.ts";

const FIELDS = `number title url state isDraft updatedAt headRefOid mergeable mergeStateStatus reviewDecision
  author { login } repository { nameWithOwner }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 20) { totalCount pageInfo { hasNextPage } nodes {
    __typename ... on CheckRun { status conclusion } ... on StatusContext { state }
  } } } } } }`;

export const BOARD_QUERY = `query KeelDashboard($after: String, $states: [PullRequestState!]) {
  viewer { login pullRequests(first: 50, after: $after, states: $states, orderBy: { field: UPDATED_AT, direction: DESC }) {
    totalCount pageInfo { hasNextPage endCursor } nodes { ${FIELDS} }
  } }
  rateLimit { remaining resetAt }
}`;

type ApiPull = {
  number?: unknown; title?: unknown; url?: unknown; state?: unknown; isDraft?: unknown; updatedAt?: unknown;
  headRefOid?: unknown; mergeable?: unknown; mergeStateStatus?: unknown; reviewDecision?: unknown;
  author?: { login?: unknown } | null;
  repository?: { nameWithOwner?: unknown } | null;
  commits?: { nodes?: Array<{ commit?: { statusCheckRollup?: { state?: unknown; contexts?: { totalCount: number; pageInfo: { hasNextPage: boolean }; nodes: Array<{ __typename: string; status?: string; conclusion?: string; state?: string }> } } | null } }> };
};

export function remotePull(raw: ApiPull): RemotePull {
  const repo = raw.repository?.nameWithOwner;
  const number = raw.number;
  if (!validPullRef(repo, number) || !["OPEN", "CLOSED", "MERGED"].includes(String(raw.state))) {
    throw new ToolError("BOARD_INVALID_RESPONSE", "GitHub 返回了无法识别的 PR 身份或状态。");
  }
  const checks = raw.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  const contexts = raw.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
  const ci = contexts ? { passed: 0, failed: 0, pending: 0, total: contexts.totalCount, complete: !contexts.pageInfo.hasNextPage && contexts.nodes.length === contexts.totalCount } : undefined;
  if (ci && contexts) for (const context of contexts.nodes) {
    const value = context.__typename === "CheckRun" ? context.status === "COMPLETED" ? context.conclusion : "PENDING" : context.state;
    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(value ?? "")) ci.passed += 1;
    else if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"].includes(value ?? "")) ci.failed += 1;
    else if (value === "PENDING" || value === "EXPECTED") ci.pending += 1;
    else ci.complete = false;
  }
  const checkState = ci && ci.failed > 0 ? "FAILURE" : ci && ci.pending > 0 && checks === "SUCCESS" ? "PENDING" : checks;
  return {
    key: pullKey(repo, number as number), repo, number: number as number,
    title: String(raw.title ?? "").slice(0, 512), url: pullUrl(repo, number as number),
    author: String(raw.author?.login ?? ""), state: raw.state as RemotePull["state"],
    isDraft: raw.isDraft === true, updatedAt: String(raw.updatedAt ?? ""), headSha: String(raw.headRefOid ?? ""),
    checks: ["SUCCESS", "FAILURE", "PENDING", "ERROR", "EXPECTED"].includes(String(checkState)) ? checkState as RemotePull["checks"] : "UNKNOWN",
    review: String(raw.reviewDecision ?? "UNKNOWN"), mergeable: String(raw.mergeable ?? "UNKNOWN"), mergeState: String(raw.mergeStateStatus ?? "UNKNOWN"),
    ...(ci ? { ci } : {}),
  };
}

export async function prBoard(_profile: unknown, params: { cursor?: string; scope?: BoardScope }): Promise<PullPage> {
  if (params.cursor !== undefined && (typeof params.cursor !== "string" || params.cursor.length > 2048)) {
    throw new ToolError("INVALID_INPUT", "看板分页 cursor 不合法。");
  }
  const args = ["api", "graphql", "--hostname", "github.com", "-f", `query=${BOARD_QUERY}`];
  if (params.cursor) args.push("-f", `after=${params.cursor}`);
  for (const state of params.scope === "all" ? ["OPEN", "CLOSED", "MERGED"] : ["OPEN"]) args.push("-f", `states[]=${state}`);
  const response = await ghJson<{
    errors?: unknown[];
    data?: { viewer?: { login: string; pullRequests: { totalCount: number; pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ApiPull[] } }; rateLimit?: { remaining: number; resetAt: string } };
  }>(args, { timeoutMs: 25_000 });
  const viewer = response.data?.viewer;
  if (response.errors?.length || !viewer?.login || !Array.isArray(viewer.pullRequests?.nodes)) {
    throw new ToolError("BOARD_INVALID_RESPONSE", "GitHub 看板响应不完整，不能当作空列表。");
  }
  const connection = viewer.pullRequests;
  if (connection.pageInfo.hasNextPage && !connection.pageInfo.endCursor) {
    throw new ToolError("BOARD_INVALID_RESPONSE", "GitHub 分页缺少后续 cursor。");
  }
  const rows = connection.nodes.map(remotePull);
  if (rows.some((row) => row.author.toLowerCase() !== viewer.login.toLowerCase())) {
    throw new ToolError("BOARD_OWNER_MISMATCH", "GitHub 返回了不属于当前账号的作者 PR，已拒绝显示。");
  }
  return {
    owner: viewer.login, rows, total: connection.totalCount,
    nextCursor: connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null,
    ...(response.data?.rateLimit ? { remaining: response.data.rateLimit.remaining, resetAt: response.data.rateLimit.resetAt } : {}),
  };
}

export async function boardLinkedPull(params: { repo: string; number: number }): Promise<RemotePull> {
  if (!validPullRef(params.repo, params.number)) throw new ToolError("INVALID_INPUT", "关联 PR 身份不合法。");
  const [owner, name] = params.repo.split("/");
  const response = await ghJson<{ data?: { repository?: { pullRequest?: ApiPull | null } | null }; errors?: unknown[] }>([
    "api", "graphql", "--hostname", "github.com", "-f", `query=query KeelLinkedPull($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){${FIELDS}}}}`,
    "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${params.number}`,
  ], { timeoutMs: 25_000 });
  const raw = response.data?.repository?.pullRequest;
  if (!raw || response.errors?.length) throw new ToolError("BOARD_PR_UNAVAILABLE", "已关联 PR 暂时无法读取，可能是网络、权限或 PR 已删除。");
  return remotePull(raw);
}
