import { describe, expect, it } from "vitest";
import { isChangeGraphDone, type ChangeGraphDoneInput } from "../../src/main/graph/done.ts";
import { buildVerdict, mapOrchLevel, type GraphVerdict } from "../../src/main/graph/verdict.ts";
import { family } from "../../src/shared/fanout.ts";

const sc = [{ id: "SC-1", hasEvidence: true }];

function verdict(over: Partial<GraphVerdict> = {}): GraphVerdict {
  return {
    repo: "acme/app",
    pr: 3,
    base_ref: "main",
    base_sha: "base",
    head_sha: "head",
    patch_id: "pid",
    level: "unit-test-verified",
    surface: "unit-test",
    by_route: { agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy" },
    by_family: "gpt",
    ...over,
  };
}

function input(over: Partial<ChangeGraphDoneInput> = {}): ChangeGraphDoneInput {
  return {
    pr_status: "report_mergeable",
    author_families: ["grok"],
    verdict: verdict(),
    current: { head_sha: "head", base_sha: "base", patch_id: "pid", patch_ok: true },
    sc,
    openHumanGates: 0,
    ...over,
  };
}

describe("mapOrchLevel", () => {
  it("FAIL is verifier-failed; PASS wording does not upgrade type-check evidence", () => {
    expect(mapOrchLevel({ verdict: "FAIL", status: "failed" })).toBe("verifier-failed");
    expect(mapOrchLevel({ verdict: "PASS", ran: [{ cmd: "npx tsc --noEmit", exit_code: 0 }] })).toBe("type-check-only");
    expect(mapOrchLevel({ verdict: "PASS+NOTES", surface: "unit-test" })).toBe("unit-test-verified");
    expect(mapOrchLevel({ verdict: "PASS", surface: "live-ui" })).toBe("live-ui-verified");
    expect(mapOrchLevel({ status: "blocked", verdict: "PASS" })).toBe("verifier-blocked");
  });

  it("buildVerdict records family from the actual route", () => {
    const v = buildVerdict({
      repo: "acme/app",
      pr: 1,
      base_ref: "main",
      base_sha: "b",
      head_sha: "h",
      patch_id: "p",
      report: { verdict: "PASS", surface: "unit-test" },
      route: { agent: "codex", model: "openai/gpt-6-luna", provider_id: "xd" },
    });
    expect(v.by_family).toBe(family("openai/gpt-6-luna"));
    expect(v.level).toBe("unit-test-verified");
  });
});

describe("isChangeGraphDone", () => {
  it("all five conditions pass", () => {
    expect(isChangeGraphDone(input())).toEqual({ done: true, missing: [], next: null });
  });

  it("each of the five conditions can fail on its own", () => {
    expect(isChangeGraphDone(input({ pr_status: "wait_for_ci" })).done).toBe(false);
    expect(isChangeGraphDone(input({ verdict: null })).done).toBe(false);
    expect(isChangeGraphDone(input({ current: { head_sha: "head", base_sha: "base", patch_id: null, patch_ok: false } })).done).toBe(false);
    expect(isChangeGraphDone(input({ sc: [{ id: "SC-1", hasEvidence: false }] })).done).toBe(false);
    expect(isChangeGraphDone(input({ openHumanGates: 1 })).done).toBe(false);
  });

  it("rejects a verifier in an author family", () => {
    const r = isChangeGraphDone(input({ author_families: ["gpt"] }));
    expect(r.done).toBe(false);
    expect(r.missing.some((m) => m.includes("作者族"))).toBe(true);
  });

  it("rejects a level below unit-test-verified", () => {
    const r = isChangeGraphDone(input({ verdict: verdict({ level: "type-check-only" }) }));
    expect(r.done).toBe(false);
    expect(r.missing.some((m) => m.includes("type-check-only"))).toBe(true);
  });

  it("FAIL does not map to a passing done", () => {
    const failed = buildVerdict({
      repo: "acme/app",
      pr: 3,
      base_ref: "main",
      base_sha: "base",
      head_sha: "head",
      patch_id: "pid",
      report: { verdict: "FAIL", status: "failed" },
      route: { agent: "codex", model: "gpt-6-luna", provider_id: "art-cindy" },
    });
    expect(failed.level).toBe("verifier-failed");
    expect(isChangeGraphDone(input({ verdict: failed })).done).toBe(false);
  });
});
