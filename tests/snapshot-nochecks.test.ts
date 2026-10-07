import { describe, expect, it } from "vitest";
import {
  PUSH_GRACE_MS,
  appearanceFromGithub,
  checksHaveAppeared,
  localPushAt,
  noChecksDecision,
  parseCheckSuites,
  requiredChecksFromProtection,
  workflowsFromContents,
  type NoChecksEvidence,
} from "../src/node/pr/snapshot.ts";
import { makeContext } from "../src/main/context.ts";
import { runTool } from "../src/main/dispatch.ts";
import { listLocalPushes } from "../src/main/pushes.ts";
import { LANE_PRESETS, type KeelProfile } from "../src/shared/types.ts";
import { fakeHost } from "./helpers/fakeHost.ts";

const facts = {
  mergeable: "MERGEABLE" as const,
  mergeStateStatus: "CLEAN" as const,
  reviewDecision: "APPROVED" as const,
  headRefOid: "abc123",
  headRefName: "feat",
  baseRefName: "main",
  state: "OPEN" as const,
  mergedAt: null,
  isDraft: false,
  context: { owner: "acme", repo: "solo", number: 1 as never },
};

const none: NoChecksEvidence = {
  hasRealCheckRuns: false,
  hasWorkflows: false,
  hasRequiredProtection: false,
  localPushedAtMs: null,
  nowMs: 1_000_000,
};

describe("check-run appearance (call-site filter)", () => {
  it("does not count queued third-party suites that never produced a check-run", () => {
    const suites = parseCheckSuites({
      check_suites: [
        { status: "queued", latest_check_runs_count: 0, app: { slug: "trae-ai-cn" } },
        { status: "queued", latest_check_runs_count: 0, app: { slug: "cursor" } },
      ],
    });
    expect(suites).not.toBe("query-failed");
    expect(checksHaveAppeared(suites as { appSlug: string; status: string; checkRuns: number }[])).toBe(false);
    expect(appearanceFromGithub({ check_suites: suites }, { total_count: 0, check_runs: [] })).toBe(false);
  });

  it("counts an app that has produced check-runs even if phantom suites are also queued", () => {
    const payload = {
      check_suites: [
        { status: "queued", latest_check_runs_count: 0, app: { slug: "trae-ai-cn" } },
        { status: "queued", latest_check_runs_count: 0, app: { slug: "cursor" } },
        { status: "in_progress", latest_check_runs_count: 3, app: { slug: "github-actions" } },
      ],
    };
    expect(appearanceFromGithub(payload, { total_count: 3, check_runs: [{}, {}, {}] })).toBe(true);
    expect(checksHaveAppeared(parseCheckSuites(payload) as { appSlug: string; status: string; checkRuns: number }[])).toBe(true);
  });
});

describe("noChecksDecision", () => {
  it("waits within 2 minutes of a KEEL local push, and does not use commit time", () => {
    const recent = noChecksDecision({ facts, threads: [] }, { ...none, localPushedAtMs: none.nowMs - 30_000 });
    expect(recent).toEqual({ kind: "waiting" });
    const expired = noChecksDecision({ facts, threads: [] }, { ...none, localPushedAtMs: none.nowMs - PUSH_GRACE_MS - 1 });
    expect(expired).toEqual({ kind: "ready" });
    // Commit timestamps are not an input; only localPushedAtMs counts.
    expect(localPushAt([{ repo: "acme/solo", head: "abc123", at_ms: 99 }], "acme/solo", "abc123")).toBe(99);
    expect(localPushAt([{ repo: "acme/solo", head: "other", at_ms: 1 }], "acme/solo", "abc123")).toBeNull();
  });

  it("waits when the head has workflow files but no checks", () => {
    expect(workflowsFromContents([{ name: "ci.yml" }, { name: "README" }])).toBe(true);
    expect(workflowsFromContents([{ name: "deploy.yaml" }])).toBe(true);
    expect(workflowsFromContents([{ name: "NOTES.md" }])).toBe(false);
    expect(noChecksDecision({ facts, threads: [] }, { ...none, hasWorkflows: true })).toEqual({ kind: "waiting" });
  });

  it("waits when base branch protection lists required checks", () => {
    expect(requiredChecksFromProtection({ contexts: ["verify"], checks: [] })).toBe(true);
    expect(requiredChecksFromProtection({ contexts: [], checks: [{ context: "verify" }] })).toBe(true);
    expect(requiredChecksFromProtection({ contexts: [], checks: [] })).toBe(false);
    expect(noChecksDecision({ facts, threads: [] }, { ...none, hasRequiredProtection: true })).toEqual({ kind: "waiting" });
  });

  it("waits when workflow or protection queries fail, instead of treating silence as no CI", () => {
    expect(noChecksDecision({ facts, threads: [] }, { ...none, hasWorkflows: "query-failed" })).toEqual({ kind: "waiting" });
    expect(noChecksDecision({ facts, threads: [] }, { ...none, hasRequiredProtection: "query-failed" })).toEqual({ kind: "waiting" });
  });

  it("is ready only for a repo that truly has no CI, no protection, and no recent KEEL push", () => {
    expect(noChecksDecision({ facts, threads: [] }, none)).toEqual({ kind: "ready" });
  });
});

const profile: KeelProfile = { lanes: [], routingPath: null, boardRepos: [], plansDir: null };

describe("KEEL local push records", () => {
  it("pr_open with push:true stores repo+head in the plugin data dir", async () => {
    const h = fakeHost({
      node: (m) =>
        m === "pr/resolve"
          ? { ok: true, result: null }
          : { ok: true, result: { url: "https://github.com/acme/solo/pull/1", number: 1, repo: "acme/solo", head_sha: "abc123" } },
    });
    const r = await runTool(makeContext(h, "c1", profile), "pr_open", {
      repo_dir: "/r", title: "feat: x", sections: "b", push: true, authorization_source: "用户 2026-10-07：提交 PR",
    });
    expect(r.ok).toBe(true);
    const pushes = await listLocalPushes(h);
    expect(pushes).toEqual([{ repo: "acme/solo", head: "abc123", at_ms: h.now() }]);
  });

  it("does not record a push when push is not requested", async () => {
    const h = fakeHost({
      node: (m) =>
        m === "pr/resolve"
          ? { ok: true, result: null }
          : { ok: true, result: { url: "u", number: 1, repo: "acme/solo", head_sha: "abc123" } },
    });
    await runTool(makeContext(h, "c1", profile), "pr_open", {
      repo_dir: "/r", title: "feat: x", sections: "b", authorization_source: "用户 2026-10-07：提交 PR",
    });
    expect(await listLocalPushes(h)).toEqual([]);
  });

  it("pr_status forwards local push records into pr/snapshot", async () => {
    const seen: unknown[] = [];
    const h = fakeHost({
      node: (m, p) => {
        seen.push([m, p]);
        return {
          ok: true,
          result: {
            preset: "personal", rule: LANE_PRESETS.personal,
            pr: { repo: "acme/solo", number: 1, url: "u", title: "t", state: "OPEN", isDraft: false, headSha: "abc123", headRef: "f", baseRef: "main", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, labels: [] },
            decision: { kind: "waiting" }, checks: { failed: [], pending: [], passed: 0 }, unresolvedThreads: 0,
            gate: { applies: false, required: [], passed: [], failing: [], pending: [], missing: [], ok: true, sources: [] },
            verification: null, mergeReadyLabel: false, rendered: "x",
          },
        };
      },
    });
    h.files.set("pushes/acme__solo__abc123.json", JSON.stringify({ repo: "acme/solo", head: "abc123", at_ms: 42 }));
    await runTool(makeContext(h, "c1", profile), "pr_status", { repo: "acme/solo", pr: 1 });
    const snapCall = seen.find((x) => Array.isArray(x) && x[0] === "pr/snapshot") as [string, { local_pushes: unknown; now_ms: number }];
    expect(snapCall[1].local_pushes).toEqual([{ repo: "acme/solo", head: "abc123", at_ms: 42 }]);
    expect(snapCall[1].now_ms).toBe(h.now());
  });
});

describe("legacy commit status still pending (review F14-01)", () => {
  it("keeps a pending StatusContext with upstream classifyPr instead of reporting ready", async () => {
    const { readSnapshot } = await import("../src/node/pr/upstream/policy.ts");
    const { fakeReader, pendingCheck } = await import("./helpers/upstream-fakes.ts");
    const { parsePrNumber } = await import("../src/node/pr/upstream/types.ts");
    const { decideOpenRow } = await import("../src/node/pr/snapshot.ts");
    const row = await readSnapshot({
      reader: fakeReader({ fastPath: { kind: "checks", checks: [pendingCheck("jenkins/test")] } }),
      context: { owner: "acme", repo: "solo", number: parsePrNumber(1) },
      pendingHistory: "omit",
      allowDraft: false,
    });
    // No workflows, no branch protection, last KEEL push long ago: the old code turned this into "ready".
    const stale = { ...none, localPushedAtMs: 0, nowMs: PUSH_GRACE_MS * 10 };
    expect(decideOpenRow(row, stale).kind).toBe("waiting");
    expect(decideOpenRow(row, null).kind).toBe("waiting");
  });
});
