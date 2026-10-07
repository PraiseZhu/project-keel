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
    expect(mapOrchLevel({ verdict: "PASS+NOTES", ran: [{ cmd: "npx vitest run", exit_code: 0 }] })).toBe("unit-test-verified");
    expect(
      mapOrchLevel({ verdict: "PASS", surface: "live-ui", ran: [{ cmd: "npx playwright test", exit_code: 0 }], ui_evidence: ["shots/home.png"] }),
    ).toBe("live-ui-verified");
    expect(mapOrchLevel({ status: "blocked", verdict: "PASS" })).toBe("verifier-blocked");
  });

  it("a self-reported surface never raises the level above the evidence", () => {
    expect(mapOrchLevel({ verdict: "PASS", surface: "unit-test" })).toBe("type-check-only");
    expect(mapOrchLevel({ verdict: "PASS", surface: "live-ui" })).toBe("type-check-only");
    expect(mapOrchLevel({ verdict: "PASS", surface: "live-ui", ran: [{ cmd: "npm test", exit_code: 0 }] })).toBe("unit-test-verified");
    // Self-report can still lower it.
    expect(mapOrchLevel({ verdict: "PASS", surface: "type-check", ran: [{ cmd: "npm test", exit_code: 0 }] })).toBe("type-check-only");
  });

  it("command names that are not real test runs give no test evidence", () => {
    const pass = (cmd: string) => mapOrchLevel({ verdict: "PASS", ran: [{ cmd, exit_code: 0 }] });
    expect(pass("npx tsc --noEmit -p tsconfig.e2e.json")).toBe("type-check-only");
    expect(pass("npx playwright --version")).toBe("type-check-only");
    expect(pass("npx vitest --version")).toBe("type-check-only");
    expect(pass("npx jest --listTests")).toBe("type-check-only");
    expect(pass("pytest -v tests/")).toBe("unit-test-verified");
    // A UI runner without UI artifacts is only unit-level evidence.
    expect(pass("npx playwright test")).toBe("unit-test-verified");
  });

  it("a runner name as an argument of another command is not a test run", () => {
    const pass = (cmd: string) => mapOrchLevel({ verdict: "PASS", ran: [{ cmd, exit_code: 0 }] });
    for (const cmd of ["rg -n vitest package.json", "grep -r jest src", "cat node_modules/.bin/vitest", "echo npm test", "ls tests | grep pytest"]) {
      expect(pass(cmd)).toBe("type-check-only");
    }
  });

  it("an exit code that may hide a failing test proves nothing", () => {
    const pass = (cmd: string) => mapOrchLevel({ verdict: "PASS", ran: [{ cmd, exit_code: 0 }] });
    for (const cmd of ["npm test | tail -20", "npm test || true", "npx vitest run; echo done", "bash -c \"$(echo npm test)\""]) {
      expect(pass(cmd)).toBe("type-check-only");
    }
  });

  it("quoted text and listing modes are not test runs", () => {
    const pass = (cmd: string) => mapOrchLevel({ verdict: "PASS", ran: [{ cmd, exit_code: 0 }] });
    for (const cmd of [
      'echo "nothing && npx vitest run"',
      "echo 'x && npm test'",
      "npx --no-install vitest list --no-cache tests/graph/done.test.ts",
      "npx vitest bench",
      "npx playwright test --list",
      "go test -list . ./...",
      "cargo test --no-run",
      "npx mocha --dry-run",
      "pytest --co -q",
    ]) {
      expect(pass(cmd), cmd).toBe("type-check-only");
    }
  });

  it("recognises real invocations through wrappers and && chains", () => {
    const pass = (cmd: string) => mapOrchLevel({ verdict: "PASS", ran: [{ cmd, exit_code: 0 }] });
    for (const cmd of [
      "npx vitest run tests/a.test.ts",
      "./node_modules/.bin/vitest run",
      "CI=1 npm run test:unit",
      "pnpm exec jest",
      "python3 -m pytest -q",
      "uv run pytest",
      "go test ./...",
      "cargo test",
      "node --test tests",
      "npm run build && npm test",
      "yarn test",
      "npm exec -- vitest run",
    ]) {
      expect(pass(cmd), cmd).toBe("unit-test-verified");
    }
  });

  it("a failing test run is verifier-failed even with PASS and a claimed surface", () => {
    expect(mapOrchLevel({ verdict: "PASS", surface: "unit-test", ran: [{ cmd: "npx vitest run", exit_code: 1 }] })).toBe("verifier-failed");
    expect(
      mapOrchLevel({ verdict: "PASS", ran: [{ cmd: "npx vitest run", exit_code: 1 }, { cmd: "npx vitest run", exit_code: 0 }] }),
    ).toBe("verifier-failed");
    // A non-test command that exits non-zero (grep with no match) is not a failure, just no evidence.
    expect(mapOrchLevel({ verdict: "PASS", ran: [{ cmd: "grep -n foo src", exit_code: 1 }, { cmd: "npm test", exit_code: 0 }] })).toBe("unit-test-verified");
  });

  it("buildVerdict records family from the actual route", () => {
    const v = buildVerdict({
      repo: "acme/app",
      pr: 1,
      base_ref: "main",
      base_sha: "b",
      head_sha: "h",
      patch_id: "p",
      report: { verdict: "PASS", surface: "unit-test", ran: [{ cmd: "npm test", exit_code: 0 }] },
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

  it("an unknown verifier route or unknown author family is not a different family", () => {
    const noRoute = isChangeGraphDone(input({ verdict: verdict({ by_family: "", by_route: { agent: "codex", model: "", provider_id: "" } }) }));
    expect(noRoute.done).toBe(false);
    expect(noRoute.missing.some((m) => m.includes("路线身份未知"))).toBe(true);
    const noAuthor = isChangeGraphDone(input({ author_families: [] }));
    expect(noAuthor.done).toBe(false);
    expect(noAuthor.missing.some((m) => m.includes("作者"))).toBe(true);
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
