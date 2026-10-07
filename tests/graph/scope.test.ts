import { describe, expect, it } from "vitest";
import { checkScope, matchScopeGlob } from "../../src/main/graph/scope.ts";

describe("checkScope", () => {
  it("allows files matching SCOPE globs and lists violations", () => {
    expect(matchScopeGlob("src/a.ts", "src/**")).toBe(true);
    expect(matchScopeGlob("docs/a.md", "src/**")).toBe(false);
    expect(matchScopeGlob("tests/foo.test.ts", "tests/**/*.test.ts")).toBe(true);
    const r = checkScope(["src/a.ts", "docs/secret.md", "tests/a.test.ts"], ["src/**", "tests/**"]);
    expect(r).toEqual({ ok: false, violations: ["docs/secret.md"] });
    expect(checkScope(["src/a.ts"], ["src/**"]).ok).toBe(true);
  });

  it("treats an empty SCOPE as no writes allowed", () => {
    expect(checkScope(["a.ts"], [])).toEqual({ ok: false, violations: ["a.ts"] });
    expect(checkScope([], []).ok).toBe(true);
  });
});
