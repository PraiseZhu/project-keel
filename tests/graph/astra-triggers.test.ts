import { describe, expect, it } from "vitest";
import {
  CROSS_MODULE_THRESHOLD,
  crossesFunctionBoundary,
  crossesFunctionBoundaryOrUnknown,
  failureFingerprint,
  isKeelArtifact,
  moduleOf,
  productFilesOf,
  shouldSkipFinalReview,
  skipFinalReviewFromWriteReports,
} from "../../src/main/graph/astra-triggers.ts";

describe("crossesFunctionBoundary", () => {
  it("is true when two or more functions_touched are present", () => {
    expect(CROSS_MODULE_THRESHOLD).toBe(2);
    expect(crossesFunctionBoundary({ functions_touched: ["login", "charge"] })).toBe(true);
    expect(moduleOf("src/auth/login.ts")).toBe("src/auth");
  });
  it("is false for a single reported function", () => {
    expect(crossesFunctionBoundary({ functions_touched: ["login"] })).toBe(false);
    expect(crossesFunctionBoundary({ functions_touched: ["login", "login"] })).toBe(false);
  });
  it("is unknown when functions_touched is missing, not false", () => {
    expect(crossesFunctionBoundary({ files_changed: ["src/auth/login.ts", "src/billing/charge.ts"] })).toBe("unknown");
    expect(crossesFunctionBoundary({})).toBe("unknown");
    expect(crossesFunctionBoundary({ functions_touched: [] })).toBe("unknown");
    expect(crossesFunctionBoundaryOrUnknown({})).toBe(true);
    expect(crossesFunctionBoundaryOrUnknown({ functions_touched: ["login"] })).toBe(false);
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
  it("skips only when every file is test/docs and lines are known and ≤30", () => {
    expect(shouldSkipFinalReview(["tests/a.test.ts", "docs/n.md"], 12)).toBe(true);
    expect(shouldSkipFinalReview(["tests/a.test.ts"])).toBe(false);
    expect(shouldSkipFinalReview(["tests/a.test.ts"], undefined)).toBe(false);
    expect(shouldSkipFinalReview(["src/a.ts"], 4)).toBe(false);
    expect(shouldSkipFinalReview(["tests/a.test.ts"], 80)).toBe(false);
  });
  it("does not treat .keel reports as product docs", () => {
    expect(isKeelArtifact(".keel/verify-same-surface-1.md")).toBe(true);
    expect(productFilesOf([".keel/verify-1.md", "docs/n.md"])).toEqual(["docs/n.md"]);
    expect(shouldSkipFinalReview([".keel/verify-1.md"], 12)).toBe(false);
    expect(shouldSkipFinalReview([".keel/verify-1.md", "docs/n.md"], 12)).toBe(true);
    expect(shouldSkipFinalReview(["src/a.ts", ".keel/verify-1.md"], 4)).toBe(false);
  });
});

describe("skipFinalReviewFromWriteReports", () => {
  it("keeps source changes when a later report only wrote .keel", () => {
    expect(skipFinalReviewFromWriteReports([
      { files_changed: ["src/login.ts"], changed_lines: 508 },
      { files_changed: [".keel/verify-same-surface-1.md"], changed_lines: 20 },
    ])).toBe(false);
  });
  it("still skips when every write-node product file is docs/tests under the line cap", () => {
    expect(skipFinalReviewFromWriteReports([
      { files_changed: ["docs/readme.md", "tests/a.test.ts"], changed_lines: 12 },
      { files_changed: [".keel/verify-same-surface-1.md"], changed_lines: 20 },
    ])).toBe(true);
  });
  it("does not skip when product line count is unknown", () => {
    expect(skipFinalReviewFromWriteReports([
      { files_changed: ["docs/readme.md"] },
    ])).toBe(false);
    expect(skipFinalReviewFromWriteReports([])).toBe(false);
  });
});
