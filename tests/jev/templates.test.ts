import { describe, expect, it } from "vitest";
import { toRequestBody } from "../../src/main/jev/client.ts";
import { decide } from "../../src/main/jev/policy.ts";
import { fromShorthand, summarise } from "../../src/main/jev/shorthand.ts";
import { MAX_BATCH, PLAYBOOKS, TEMPLATES, type TemplateId } from "../../src/main/jev/templates.ts";

const state: Record<string, unknown> = {
  task: "修复登录页按钮无响应",
  candidates: [{ label: "a" }, { label: "b" }],
  allowed_actions: ["wait_for_ci", "triage_review_threads"],
  items: Array.from({ length: 60 }, (_, i) => ({ id: `f${i}`, body: "finding" })),
};

describe("J1–J12 templates", () => {
  it("has exactly twelve templates and 23 playbooks", () => {
    expect(Object.keys(TEMPLATES)).toHaveLength(12);
    expect(PLAYBOOKS).toHaveLength(23);
  });
  it.each(Object.keys(TEMPLATES) as TemplateId[])("%s builds questions inside Typesafe limits", (id) => {
    const args = TEMPLATES[id].build(state);
    expect(() => toRequestBody(args)).not.toThrow();
    for (const q of Object.values(args.questions)) {
      if (q.type === "choice") expect(Object.keys(q.criteria as object).length).toBeLessThanOrEqual(255);
      if (q.type === "score") expect((q.criteria as unknown[]).length).toBeGreaterThanOrEqual(2);
    }
  });
  it("J1 offers 23 playbooks plus figure-it-out and trivial", () => {
    const c = TEMPLATES.J1.build(state).questions.playbook!.criteria as object;
    expect(Object.keys(c)).toHaveLength(25);
  });
  it("J4 fixes options to P0/P1/P2/P3/not_real and caps the batch", () => {
    const qs = TEMPLATES.J4.build(state).questions;
    expect(Object.keys(qs)).toHaveLength(MAX_BATCH);
    expect(Object.keys(qs.sev_0!.criteria as object)).toEqual(["P0", "P1", "P2", "P3", "not_real"]);
  });
  it("J8 only offers the actions the policy allowed", () => {
    expect(Object.keys(TEMPLATES.J8.build(state).questions.next!.criteria as object)).toEqual(["wait_for_ci", "triage_review_threads"]);
  });
});

describe("threshold policy", () => {
  const t = TEMPLATES.J1;
  it("acts at ≥ 0.75", () => {
    expect(decide({ template: t, interpretation: { value: "bug-fix", confidence: 0.75 }, alreadyReasked: false }).action).toBe("act");
  });
  it("re-asks once below threshold, then takes the minimal option", () => {
    expect(decide({ template: t, interpretation: { value: "bug-fix", confidence: 0.6 }, alreadyReasked: false }).action).toBe("reask");
    const m = decide({ template: t, interpretation: { value: "bug-fix", confidence: 0.6 }, alreadyReasked: true });
    expect(m).toMatchObject({ action: "minimal", value: "figure-it-out" });
  });
  it("J7 needs 0.8", () => {
    expect(decide({ template: TEMPLATES.J7, interpretation: { value: "update_assertion", confidence: 0.78 }, alreadyReasked: true })).toMatchObject({ action: "minimal", value: "real_regression", threshold: 0.8 });
    expect(decide({ template: TEMPLATES.J7, interpretation: { value: "update_assertion", confidence: 0.8 }, alreadyReasked: false }).action).toBe("act");
  });
  it("stops when Jev is unavailable for a collateral judgement, else falls back to minimal", () => {
    expect(decide({ template: TEMPLATES.J7, interpretation: null, alreadyReasked: false }).action).toBe("stop");
    expect(decide({ template: TEMPLATES.J5, interpretation: null, alreadyReasked: false })).toMatchObject({ action: "minimal", value: "ask" });
  });
});

describe("jev shorthand", () => {
  it("converts choice/score/yesno", () => {
    expect(fromShorthand({ question: "选哪个", kind: "choice", options: ["a", "b"] }).questions.answer).toEqual({ type: "choice", instructions: "选哪个", criteria: { a: null, b: null } });
    expect(fromShorthand({ question: "多重要", kind: "score" }).questions.answer!.criteria).toEqual(["低", "中", "高"]);
    expect(fromShorthand({ question: "该继续吗", kind: "yesno", context: { x: 1 } })).toEqual({ state: { x: 1 }, questions: { answer: { type: "noul", instructions: "该继续吗" } } });
    expect(() => fromShorthand({ question: "x", kind: "choice" })).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  });
  it("summarises in Chinese with a threshold hint", () => {
    const s = summarise({ model: "m", usage: { input_tokens: 1, output_tokens: 1 }, answers: { answer: { type: "choice", choice: "a", confidence: 0.6, probabilities: { a: 0.6 } } } }, 0.75);
    expect(s.summary).toContain("选「a」");
    expect(s.confidence_hint.answer).toEqual({ confidence: 0.6, meets_threshold: false });
  });
});

import { readFileSync } from "node:fs";
it("tests/playbooks.json fixture matches PLAYBOOKS", () => {
  expect(JSON.parse(readFileSync("tests/playbooks.json", "utf8"))).toEqual([...PLAYBOOKS]);
});

it("J1 puts playbook notes into criteria descriptions, not into state", () => {
  const args = TEMPLATES.J1.build({ task: "x", playbook_notes: { "bug-fix": "Plan, review, verify." } });
  expect(args.state).toEqual({ task: "x" });
  expect((args.questions.playbook!.criteria as Record<string, unknown>)["bug-fix"]).toBe("Plan, review, verify.");
});
