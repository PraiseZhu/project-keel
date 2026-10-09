import { describe, expect, it } from "vitest";
import {
  CROSS_MODULE_THRESHOLD,
  crossesFunctionBoundary,
  crossesFunctionBoundaryOrUnknown,
  failureFingerprint,
  moduleOf,
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
