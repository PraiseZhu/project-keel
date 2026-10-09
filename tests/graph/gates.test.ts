import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { GATES, keywordCandidates } from "../../src/main/graph/gates.ts";
import { canonicalize, memoryGateStore, runGate, type JevStub } from "../../src/main/jev/gates.ts";
import { makeContext } from "../../src/main/context.ts";
import * as judge from "../../src/main/judge.ts";
import * as templates from "../../src/main/jev/templates.ts";
import { fakeHost, typesafeAnswering } from "../helpers/fakeHost.ts";

const ctx = () => makeContext(fakeHost({ fetch: typesafeAnswering(0.9) }), "c1");

function jev(choice: string, confidence: number): JevStub {
  return async () => ({ choice, confidence });
}

function unavailable(): JevStub {
  return async () => {
    throw new Error("down");
  };
}

describe("source isolation", () => {
  it("graph gate files do not import the legacy judge / templates / policy / pstack modules", () => {
    const files = ["src/main/graph/gates.ts", "src/main/jev/gates.ts"].map((f) => readFileSync(f, "utf8")).join("\n");
    expect(files).not.toMatch(/^\s*import\s.+from\s+["'][^"']*(jev\/templates|judge|jev\/policy|tools\/pstack)/m);
  });
  it("runGate does not call judge or templates", async () => {
    const judgeSpy = vi.spyOn(judge, "judge");
    const itemsSpy = vi.spyOn(judge, "judgeItems");
    const tplSpy = vi.spyOn(templates, "template");
    await runGate(ctx(), "G-arena", { lines: 8 }, { run_id: "run-spy" });
    expect(judgeSpy).not.toHaveBeenCalled();
    expect(itemsSpy).not.toHaveBeenCalled();
    expect(tplSpy).not.toHaveBeenCalled();
    judgeSpy.mockRestore();
    itemsSpy.mockRestore();
    tplSpy.mockRestore();
  });
});

describe("G-route", () => {
  it("takes an explicit unit-graph playbook without Jev", async () => {
    const stub = vi.fn(jev("feature", 0.99));
    const r = await runGate(ctx(), "G-route", { playbook: "bug-fix", task: "新增功能" }, { run_id: "r1", jev: stub });
    expect(r).toMatchObject({ gate: "G-route", deterministic: "bug-fix", routed: "act", value: "bug-fix" });
    expect(stub).not.toHaveBeenCalled();
  });
  it("is deterministic when keywords hit exactly one unit graph", async () => {
    expect(keywordCandidates("修一下登录报错")).toEqual(["bug-fix"]);
    const r = await runGate(ctx(), "G-route", { task: "修一下登录报错" }, { run_id: "r1", jev: jev("feature", 0.99) });
    expect(r).toMatchObject({ deterministic: "bug-fix", routed: "act", value: "bug-fix" });
  });
  it("asks Jev among the top 3 keyword candidates and acts at ≥0.75", async () => {
    const hits = keywordCandidates("重构登录功能");
    expect(hits.length).toBeGreaterThan(1);
    const r = await runGate(ctx(), "G-route", { task: "重构登录功能" }, { run_id: "r1", jev: jev("refactoring", 0.88) });
    expect(r).toMatchObject({ routed: "act", value: "refactoring" });
    expect(r.jev).toEqual({ choice: "refactoring", confidence: 0.88 });
    expect(r.deterministic).toBeUndefined();
  });
  it("below threshold routes a direction gate to lead or astra", async () => {
    const ev = { task: "重构登录功能" };
    const lead = await runGate(ctx(), "G-route", ev, { run_id: "r-lead", direction_gate: "lead", jev: jev("feature", 0.4) });
    expect(lead.routed).toBe("lead");
    const astra = await runGate(ctx(), "G-route", ev, { run_id: "r-astra", direction_gate: "astra", jev: jev("feature", 0.4) });
    expect(astra.routed).toBe("astra");
  });
});

describe("G-advance", () => {
  it("advances when evidence exists, head matches, and exit_code is 0", async () => {
    const r = await runGate(ctx(), "G-advance", { evidence_present: true, head_matches: true, exit_code: 0 }, { run_id: "r1", jev: jev("stay", 0.99) });
    expect(r).toMatchObject({ deterministic: "advance", routed: "act", value: "advance" });
  });
  it("asks Jev otherwise and acts above threshold", async () => {
    const r = await runGate(ctx(), "G-advance", { evidence_present: false, head_matches: true, exit_code: 0 }, { run_id: "r1", jev: jev("stay", 0.8) });
    expect(r).toMatchObject({ routed: "act", value: "stay" });
  });
  it("defaults to stay the first time, then advance when there is new evidence", async () => {
    const first = await runGate(ctx(), "G-advance", { evidence_present: false, head_matches: true }, { run_id: "r1", jev: jev("advance", 0.2) });
    expect(first).toMatchObject({ routed: "default", value: "stay" });
    const later = await runGate(ctx(), "G-advance", { evidence_present: true, head_matches: true, new_evidence: true }, { run_id: "r2", jev: jev("stay", 0.2) });
    expect(later).toMatchObject({ routed: "default", value: "advance" });
  });
  it("a prior stay is not evidence: unchanged failing facts keep staying", async () => {
    const failing = { evidence_present: false, head_matches: false, exit_code: 1 };
    const first = await runGate(ctx(), "G-advance", failing, { run_id: "r1", jev: jev("advance", 0.1) });
    expect(first.value).toBe("stay");
    const again = await runGate(ctx(), "G-advance", { ...failing, prior_stay: true, new_evidence: false }, { run_id: "r1", jev: unavailable() });
    expect(again.value).toBe("stay");
    const priorOnly = await runGate(ctx(), "G-advance", { evidence_present: false, prior_stay: true }, { run_id: "r3", jev: unavailable() });
    expect(priorOnly).toMatchObject({ routed: "default", value: "stay" });
  });
  it("a known failure stays deterministically, even with new evidence or a confident Jev", async () => {
    for (const e of [
      { evidence_present: true, head_matches: true, exit_code: 1, new_evidence: true },
      { evidence_present: true, head_matches: false, exit_code: 0, new_evidence: true },
    ]) {
      const r = await runGate(ctx(), "G-advance", e, { run_id: "r1", jev: jev("advance", 0.99) });
      expect(r).toMatchObject({ deterministic: "stay", routed: "act", value: "stay" });
    }
  });
});

describe("G-retry", () => {
  it("maps known error_mode without Jev", async () => {
    expect(await runGate(ctx(), "G-retry", { error_mode: "network" }, { run_id: "r1", jev: jev("stop", 0.99) })).toMatchObject({ deterministic: "retry", value: "retry" });
    expect(await runGate(ctx(), "G-retry", { error_mode: "tool" }, { run_id: "r1", jev: jev("retry", 0.99) })).toMatchObject({ deterministic: "escalate", value: "escalate" });
    expect(await runGate(ctx(), "G-retry", { error_mode: "overlong" }, { run_id: "r1", jev: jev("retry", 0.99) })).toMatchObject({ deterministic: "escalate" });
    expect(await runGate(ctx(), "G-retry", { error_mode: "overbudget" }, { run_id: "r1", jev: jev("retry", 0.99) })).toMatchObject({ deterministic: "escalate" });
    expect(await runGate(ctx(), "G-retry", { consecutive_failures: 2, error_mode: "network" }, { run_id: "r1", jev: jev("retry", 0.99) })).toMatchObject({ deterministic: "stop", value: "stop" });
  });
  it("asks Jev when the mode is unknown and acts above threshold", async () => {
    const r = await runGate(ctx(), "G-retry", { error_mode: "unknown", consecutive_failures: 1 }, { run_id: "r1", jev: jev("escalate", 0.91) });
    expect(r).toMatchObject({ routed: "act", value: "escalate" });
  });
  it("falls back to retry, then stop after two failures, when Jev is low or missing", async () => {
    const low = await runGate(ctx(), "G-retry", { error_mode: "unknown" }, { run_id: "r1", jev: jev("stop", 0.1) });
    expect(low).toMatchObject({ routed: "default", value: "retry" });
    const twice = await runGate(ctx(), "G-retry", { error_mode: "unknown", consecutive_failures: 2 }, { run_id: "r1", jev: jev("retry", 0.1) });
    expect(twice).toMatchObject({ deterministic: "stop", value: "stop" });
  });
});

describe("G-accept", () => {
  it("adopts an Astra PASS without Jev", async () => {
    const stub = vi.fn(jev("revise", 0.99));
    const r = await runGate(ctx(), "G-accept", { verdict: "PASS" }, { run_id: "r1", direction_gate: "astra", jev: stub });
    expect(r).toMatchObject({ deterministic: "adopt", routed: "act", value: "adopt" });
    expect(stub).not.toHaveBeenCalled();
  });
  it("adopts PASS+NOTES without Jev", async () => {
    const stub = vi.fn(jev("revise", 0.99));
    const r = await runGate(ctx(), "G-accept", { verdict: "PASS+NOTES" }, { run_id: "r1", jev: stub });
    expect(r).toMatchObject({ deterministic: "adopt", routed: "act", value: "adopt" });
    expect(stub).not.toHaveBeenCalled();
  });
  it("revises a FAIL without Jev", async () => {
    const stub = vi.fn(jev("ask_user", 0.99));
    const r = await runGate(ctx(), "G-accept", { verdict: "FAIL" }, { run_id: "r1", direction_gate: "astra", jev: stub });
    expect(r).toMatchObject({ deterministic: "revise", routed: "act", value: "revise" });
    expect(stub).not.toHaveBeenCalled();
  });
  it("asks Jev when the verdict is missing", async () => {
    const r = await runGate(ctx(), "G-accept", {}, { run_id: "r1", jev: jev("revise", 0.8) });
    expect(r).toMatchObject({ routed: "act", value: "revise" });
    expect(r.deterministic).toBeUndefined();
  });
  it("never sends a low-confidence accept back to Astra", async () => {
    const r = await runGate(ctx(), "G-accept", {}, { run_id: "r1", direction_gate: "astra", jev: jev("adopt", 0.2) });
    expect(r.routed).toBe("lead");
  });
  it("labels options to match the g-accept edges", () => {
    const q = GATES["G-accept"].question({ verdict: "FAIL" });
    expect(q.criteria.adopt).toMatch(/验证/);
    expect(q.criteria.revise).toMatch(/按意见改/);
    expect(q.criteria.ask_user).toMatch(/主控|用户/);
    expect(q.criteria.adopt).not.toMatch(/按意见改/);
  });
});

describe("G-arena", () => {
  it("stays single at ≤30 lines", async () => {
    const r = await runGate(ctx(), "G-arena", { lines: 30 }, { run_id: "r1", jev: jev("arena", 0.99) });
    expect(r).toMatchObject({ deterministic: "single", routed: "act", value: "single" });
  });
  it("asks Jev above 30 lines and defaults to single below threshold", async () => {
    const act = await runGate(ctx(), "G-arena", { changed_lines: 80 }, { run_id: "r1", jev: jev("arena", 0.77) });
    expect(act).toMatchObject({ routed: "act", value: "arena" });
    const low = await runGate(ctx(), "G-arena", { lines: 80 }, { run_id: "r2", direction_gate: "lead", jev: jev("arena", 0.2) });
    expect(low).toMatchObject({ routed: "lead", value: "arena" });
    const missing = await runGate(ctx(), "G-arena", { lines: 80 }, { run_id: "r3", jev: unavailable() });
    expect(missing).toMatchObject({ routed: "lead", value: "single" });
  });
});

describe("Jev unavailable and investigation", () => {
  it("treats Jev failure as below threshold", async () => {
    const r = await runGate(ctx(), "G-advance", { present: false, head_matches: true }, { run_id: "r1", jev: unavailable() });
    expect(r).toMatchObject({ routed: "default", value: "stay" });
    expect(r.jev).toBeUndefined();
  });
  it("investigation direction gates always route to lead, never Astra", async () => {
    const r = await runGate(ctx(), "G-route", { task: "重构登录功能" }, { run_id: "r1", graph: "investigation", direction_gate: "astra", jev: jev("feature", 0.2) });
    expect(r.routed).toBe("lead");
    const arena = await runGate(ctx(), "G-arena", { lines: 90 }, { run_id: "r2", graph: "investigation", direction_gate: "astra", jev: jev("arena", 0.2) });
    expect(arena.routed).toBe("lead");
  });
});

describe("same-evidence cache", () => {
  it("asks Jev only once for the same canonical evidence", async () => {
    const store = memoryGateStore();
    const stub = vi.fn(jev("arena", 0.9));
    const ev = { lines: 90, note: "x" };
    const a = await runGate(ctx(), "G-arena", ev, { run_id: "run-cache", store, jev: stub });
    const b = await runGate(ctx(), "G-arena", { note: "x", lines: 90 }, { run_id: "run-cache", store, jev: stub });
    expect(stub).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
    expect(canonicalize({ b: 1, a: 2 })).toEqual({ a: 2, b: 1 });
  });
});

describe("gate table", () => {
  it("exposes all five gates with kind and options", () => {
    expect(Object.keys(GATES).sort()).toEqual(["G-accept", "G-advance", "G-arena", "G-retry", "G-route"]);
    expect(GATES["G-route"].kind).toBe("direction");
    expect(GATES["G-advance"].kind).toBe("mechanical");
    expect(GATES["G-retry"].kind).toBe("mechanical");
    expect(GATES["G-accept"].kind).toBe("direction");
    expect(GATES["G-arena"].kind).toBe("direction");
  });
});
