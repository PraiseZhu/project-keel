import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KeelError } from "../../src/main/host.ts";
import { parseNodeReport } from "../../src/main/graph/report.ts";
import { dispatch } from "../../src/node/rpc.ts";
import { truncateTail } from "../../src/node/git/ci.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const payload = {
  dispatch_key: "run:node:1",
  status: "done" as const,
  summary: "ok",
  files_changed: ["src/a.ts"],
  ran: [{ cmd: "npm test", exit_code: 0 }],
  verdict: "PASS" as const,
};

describe("parseNodeReport", () => {
  it("parses a fenced NodeReport and keeps the body", () => {
    const text = `前言\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n\n说明文字\n`;
    const r = parseNodeReport(text, "run:node:1");
    expect(r).toMatchObject({ dispatch_key: "run:node:1", status: "done", files_changed: ["src/a.ts"], verdict: "PASS" });
    expect(r.body).toContain("说明文字");
  });

  it("parses an inline JSON report", () => {
    expect(parseNodeReport(JSON.stringify(payload), "run:node:1").summary).toBe("ok");
  });

  it("rejects a mismatched dispatch_key and malformed reports", () => {
    expect(() => parseNodeReport(JSON.stringify(payload), "other")).toThrow(expect.objectContaining({ code: "DISPATCH_KEY_UNKNOWN" }));
    expect(() => parseNodeReport("no json here", "run:node:1")).toThrow(expect.objectContaining({ code: "REPORT_INVALID" }));
    expect(() => parseNodeReport("```json\n{\n```", "run:node:1")).toThrow(KeelError);
  });
});

describe("report/read whitelist", () => {
  it("reads only worktree/.keel/<node>-<attempt>.md", async () => {
    mkdirSync("_tmp/test-runs", { recursive: true });
    const dir = mkdtempSync(resolve("_tmp/test-runs/report-"));
    dirs.push(dir);
    mkdirSync(join(dir, ".keel"));
    writeFileSync(join(dir, ".keel", "implement-2.md"), "hello");
    writeFileSync(join(dir, "secret.md"), "nope");
    const ok = await dispatch("report/read", { worktree: dir, node: "implement", attempt: 2 });
    expect(ok.result).toMatchObject({ content: "hello" });
    const bad = await dispatch("report/read", { worktree: dir, node: "../secret", attempt: 1 });
    expect(bad.error?.message).toMatch(/INVALID_INPUT/);
  });
});

describe("ci log tail", () => {
  it("keeps a byte cap on the tail", () => {
    const text = "a".repeat(1000);
    const out = truncateTail(text, 10);
    expect(Buffer.byteLength(out, "utf8")).toBe(10);
    expect(truncateTail("short", 100)).toBe("short");
  });
});
