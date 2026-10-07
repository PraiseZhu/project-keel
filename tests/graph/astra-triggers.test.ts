import { describe, expect, it } from "vitest";
import {
  CROSS_MODULE_THRESHOLD,
  crossesFunctionBoundary,
  failureFingerprint,
  moduleOf,
  shouldSkipFinalReview,
} from "../../src/main/graph/astra-triggers.ts";

describe("crossesFunctionBoundary", () => {
  it("is false for a single module, even with several files", () => {
    expect(CROSS_MODULE_THRESHOLD).toBe(2);
    expect(crossesFunctionBoundary(["src/auth/login.ts", "src/auth/session.ts"])).toBe(false);
    expect(moduleOf("src/auth/login.ts")).toBe("src/auth");
  });
  it("is true when two non-test modules change", () => {
    expect(crossesFunctionBoundary(["src/auth/login.ts", "src/billing/charge.ts"])).toBe(true);
  });
  it("ignores tests and docs when counting modules", () => {
    expect(crossesFunctionBoundary(["src/auth/login.ts", "tests/auth.test.ts", "docs/auth.md"])).toBe(false);
  });
});

describe("failureFingerprint", () => {
  it("prefers a failing command, then a finding", () => {
    expect(failureFingerprint({ ran: [{ cmd: "npx vitest run", exit_code: 1 }], findings: ["other"] })).toBe("npx vitest run");
    expect(failureFingerprint({ ran: [{ cmd: "npm test", exit_code: 0 }], findings: ["TypeError: boom"] })).toBe("typeerror: boom");
  });
  it("is undefined when nothing failed", () => {
    expect(failureFingerprint({ ran: [{ cmd: "npm test", exit_code: 0 }], summary: "" })).toBeUndefined();
  });
});

describe("shouldSkipFinalReview", () => {
  it("skips when every file is test/docs and lines ≤30 or unknown", () => {
    expect(shouldSkipFinalReview(["tests/a.test.ts", "docs/n.md"], 12)).toBe(true);
    expect(shouldSkipFinalReview(["tests/a.test.ts"])).toBe(true);
    expect(shouldSkipFinalReview(["src/a.ts"], 4)).toBe(false);
    expect(shouldSkipFinalReview(["tests/a.test.ts"], 80)).toBe(false);
  });
});
