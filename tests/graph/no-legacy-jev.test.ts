import { describe, expect, it, vi } from "vitest";
import { makeContext } from "../../src/main/context.ts";
import { readPrFacts } from "../../src/main/graph/pr-facts.ts";
import * as judgeMod from "../../src/main/judge.ts";
import { LANE_PRESETS } from "../../src/shared/types.ts";
import { fakeHost } from "../helpers/fakeHost.ts";

const pr = {
  repo: "acme/app",
  number: 9,
  url: "https://github.com/acme/app/pull/9",
  title: "x",
  state: "OPEN" as const,
  isDraft: false,
  headSha: "abc",
  headRef: "f",
  baseRef: "main",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: null,
  labels: [],
};

const snapshot = {
  preset: "personal" as const,
  rule: LANE_PRESETS.personal,
  pr,
  decision: { kind: "ready" as const },
  checks: { failed: [], pending: [], passed: 1 },
  unresolvedThreads: 0,
  gate: { applies: false, required: [], passed: [], failing: [], pending: [], missing: [], ok: true, sources: [] },
  verification: null,
  mergeReadyLabel: false,
  rendered: "x",
};

describe("pr-facts path never calls legacy Jev", () => {
  it("does not call judge or judgeItems", async () => {
    const judge = vi.spyOn(judgeMod, "judge");
    const judgeItems = vi.spyOn(judgeMod, "judgeItems");
    const calls: string[] = [];
    const h = fakeHost({
      node: (method) => {
        calls.push(method);
        if (method === "pr/snapshot") return { ok: true, result: snapshot };
        if (method === "pr/threads") return { ok: true, result: { repo: pr.repo, number: pr.number, threads: [{ id: "t1", author: "a", path: "f.ts", line: 1, body: "nits", is_bot: false }] } };
        return { ok: false, message: method };
      },
    });
    const facts = await readPrFacts(makeContext(h, "c1"), { repo: "acme/app", pr: 9 });
    expect(facts.threads).toHaveLength(1);
    expect(facts.nextAction).toBe("report_mergeable");
    expect(calls).toEqual(["pr/snapshot", "pr/threads"]);
    expect(judge).not.toHaveBeenCalled();
    expect(judgeItems).not.toHaveBeenCalled();
    judge.mockRestore();
    judgeItems.mockRestore();
  });
});
