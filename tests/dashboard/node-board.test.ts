import { beforeEach, describe, expect, it, vi } from "vitest";
const mocked = vi.hoisted(() => ({ ghJson: vi.fn() }));
vi.mock("../../src/node/env.ts", async (original) => ({ ...(await original<object>()), ghJson: mocked.ghJson }));
import { boardLinkedPull, prBoard, remotePull } from "../../src/node/pr/board.ts";

const raw = (overrides = {}) => ({ number: 42, title: "PR", url: "javascript:alert(1)", repository: { nameWithOwner: "sample/repo" }, author: { login: "demo" }, state: "OPEN", isDraft: false, headRefOid: "a".repeat(40), updatedAt: "2026-10-18T00:00:00Z", commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING", contexts: { totalCount: 3, pageInfo: { hasNextPage: false }, nodes: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }, { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }, { __typename: "StatusContext", state: "PENDING" }] } } } }] }, ...overrides });
beforeEach(() => mocked.ghJson.mockReset());

describe("GitHub viewer dashboard", () => {
  it("uses viewer cursor pagination across all repositories, not search's global cap", async () => {
    mocked.ghJson.mockResolvedValue({ data: { viewer: { login: "demo", pullRequests: { nodes: [raw()], totalCount: 1200, pageInfo: { hasNextPage: true, endCursor: "next" } } }, rateLimit: { remaining: 100, resetAt: "2026-10-18T00:00:00Z" } } });
    const page = await prBoard({ boardRepos: ["only/repo"] }, { scope: "all", cursor: "prior" });
    expect(page).toMatchObject({ total: 1200, nextCursor: "next", owner: "demo" });
    const args = mocked.ghJson.mock.calls[0]![0] as string[];
    expect(args).toContain("after=prior"); expect(args).toContain("states[]=MERGED"); expect(args).toContain("states[]=CLOSED");
    expect(args.join(" ")).toContain("viewer"); expect(args.join(" ")).not.toContain("only/repo"); expect(args).not.toContain("search");
  });
  it("does not accept a missing next cursor or another author's row", async () => {
    mocked.ghJson.mockResolvedValue({ data: { viewer: { login: "demo", pullRequests: { nodes: [], totalCount: 10, pageInfo: { hasNextPage: true, endCursor: null } } } } });
    await expect(prBoard({}, {})).rejects.toMatchObject({ code: "BOARD_INVALID_RESPONSE" });
    mocked.ghJson.mockResolvedValue({ data: { viewer: { login: "demo", pullRequests: { nodes: [raw({ author: { login: "other" } })], totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null } } } } });
    await expect(prBoard({}, {})).rejects.toMatchObject({ code: "BOARD_OWNER_MISMATCH" });
  });
  it("does not turn GraphQL errors into an empty successful result", async () => {
    mocked.ghJson.mockResolvedValue({ errors: [{ message: "permission denied" }], data: null });
    await expect(prBoard({}, {})).rejects.toMatchObject({ code: "BOARD_INVALID_RESPONSE" });
  });
  it("normalizes URLs and accurately reports incomplete check details", () => {
    const row = remotePull(raw());
    expect(row.url).toBe("https://github.com/sample/repo/pull/42");
    expect(row.ci).toEqual({ total: 3, passed: 1, failed: 1, pending: 1, complete: true });
    const incomplete = raw(); incomplete.commits.nodes[0]!.commit.statusCheckRollup.contexts.pageInfo.hasNextPage = true;
    expect(remotePull(incomplete).ci?.complete).toBe(false);
  });
  it("rejects invalid associated identities before invoking GitHub", async () => {
    await expect(boardLinkedPull({ repo: "sample/repo/../../other", number: 1 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(mocked.ghJson).not.toHaveBeenCalled();
  });
});
