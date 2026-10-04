import { describe, expect, it } from "vitest";
import { allowedActions, draftFor, evaluateGate, resolveLane } from "../src/shared/lanes.ts";
import { LANE_PRESETS, type KeelProfile } from "../src/shared/types.ts";
import { makeContext } from "../src/main/context.ts";
import { runTool } from "../src/main/dispatch.ts";
import { writeHandoff } from "../src/main/handoff.ts";
import { fakeHost } from "./helpers/fakeHost.ts";

const profile: KeelProfile = {
  lanes: [
    { repo: "Acme/Gated-App", preset: "draft-gated-handoff", baseRuleFiles: { requiredChecks: "docs/required.json" } },
    { repo: "acme/client", preset: "gated-handoff" },
  ],
  routingPath: null, boardRepos: [], plansDir: null,
};
const gated = LANE_PRESETS["draft-gated-handoff"];

describe("lane resolution", () => {
  it("matches repos case-insensitively and defaults to personal", () => {
    expect(resolveLane(profile, "acme/gated-app").rule.preset).toBe("draft-gated-handoff");
    expect(resolveLane(profile, "acme/gated-app").rule.baseRuleFiles?.requiredChecks).toBe("docs/required.json");
    expect(resolveLane(profile, "someone/else").rule.preset).toBe("personal");
  });
  it("forces Draft in the draft-first lane; personal defaults to non-draft", () => {
    expect(draftFor(gated, false)).toEqual({ draft: true, forced: true });
    expect(draftFor(gated, undefined)).toEqual({ draft: true, forced: false });
    expect(draftFor(LANE_PRESETS.personal, undefined)).toEqual({ draft: false, forced: false });
    expect(draftFor(LANE_PRESETS.personal, true)).toEqual({ draft: true, forced: false });
  });
});

describe("Ready gate", () => {
  it("fails when no required checks are known", () => {
    const g = evaluateGate(gated, [], [{ name: "build", bucket: "pass" }], []);
    expect(g.ok).toBe(false);
    expect(g.missing).toEqual(["(no required checks found)"]);
  });
  it("fails when any required check is missing, pending or failing", () => {
    const g = evaluateGate(gated, ["build", "lint", "e2e", "unit"], [{ name: "build", bucket: "pass" }, { name: "lint", bucket: "pending" }, { name: "e2e", bucket: "fail" }], []);
    expect(g).toMatchObject({ ok: false, passed: ["build"], pending: ["lint"], failing: ["e2e"], missing: ["unit"] });
  });
  it("passes only when every required check passes", () => {
    expect(evaluateGate(gated, ["build", "lint"], [{ name: "build", bucket: "pass" }, { name: "lint", bucket: "pass" }], []).ok).toBe(true);
  });
  it("does not apply in the personal lane", () => {
    expect(evaluateGate(LANE_PRESETS.personal, [], [], [])).toMatchObject({ applies: false, ok: true });
  });
});

describe("allowed actions", () => {
  const gate = evaluateGate(gated, ["build"], [{ name: "build", bucket: "pass" }], []);
  it("ready PRs: automation lanes hand off, personal lane reports mergeable — never merge", () => {
    expect(allowedActions({ rule: gated, decision: "ready", isDraft: false, gate, handedOff: false })).toEqual(["handoff"]);
    expect(allowedActions({ rule: LANE_PRESETS.personal, decision: "ready", isDraft: false, gate, handedOff: false })).toEqual(["report_mergeable"]);
  });
  it("after handoff only stopping is allowed", () => {
    expect(allowedActions({ rule: gated, decision: "blocker", blocker: "review-threads", isDraft: false, gate, handedOff: true })).toEqual(["stopped_after_handoff"]);
  });
  it("draft with gate unmet cannot be marked ready", () => {
    const unmet = evaluateGate(gated, ["build"], [], []);
    expect(allowedActions({ rule: gated, decision: "blocker", blocker: "draft-pr", isDraft: true, gate: unmet, handedOff: false })).toEqual(["wait_for_ci"]);
    expect(allowedActions({ rule: gated, decision: "blocker", blocker: "draft-pr", isDraft: true, gate, handedOff: false })).toContain("mark_ready");
  });
});

// Tool-level lane enforcement with a fake Node worker.
const pr = { repo: "acme/gated-app", number: 7, url: "https://github.com/acme/gated-app/pull/7", title: "feat: x", state: "OPEN", isDraft: true, headSha: "abc", headRef: "f", baseRef: "main", mergeable: "MERGEABLE", mergeStateStatus: "DRAFT", reviewDecision: null, labels: [] };
function snapshot(gateOk: boolean) {
  const g = evaluateGate(gated, ["build"], gateOk ? [{ name: "build", bucket: "pass" }] : [], []);
  return { preset: "draft-gated-handoff", rule: gated, pr, decision: { kind: "blocker", blocker: "draft-pr" }, checks: { failed: [], pending: [], passed: gateOk ? 1 : 0 }, unresolvedThreads: 0, gate: g, mergeReadyLabel: false, rendered: "x" };
}
function nodeFake(gateOk: boolean, calls: string[]) {
  return (method: string, params: any) => {
    calls.push(method);
    if (method === "pr/snapshot") return { ok: true, result: snapshot(gateOk) };
    if (method === "pr/ready") {
      const s = snapshot(gateOk);
      const missing = s.gate.ok ? [] : s.gate.missing;
      return { ok: true, result: { gate: { passed: s.gate.ok, missing, required: s.gate.required, sources: [] }, ready: s.gate.ok && !params.dry_run, executed: s.gate.ok && !params.dry_run, head_sha: "abc" } };
    }
    if (method === "pr/reply") return { ok: true, result: { posted: true } };
    return { ok: false, message: "UNEXPECTED: " + method };
  };
}

describe("pr_ready / pr_reply lane enforcement", () => {
  it("returns GATE_NOT_MET when required checks are missing or not passing", async () => {
    const calls: string[] = [];
    const h = fakeHost({ node: nodeFake(false, calls) });
    const r = await runTool(makeContext(h, "c1", profile), "pr_ready", { repo: "acme/gated-app", pr: 7, authorization_source: "用户 2026-10-04：转 ready" });
    expect(r).toMatchObject({ ok: false, errorCode: "GATE_NOT_MET" });
  });
  it("dry_run evaluates only and never hands off", async () => {
    const calls: string[] = [];
    const h = fakeHost({ node: nodeFake(true, calls) });
    const r = await runTool(makeContext(h, "c1", profile), "pr_ready", { repo: "acme/gated-app", pr: 7, dry_run: true });
    expect(r).toMatchObject({ ok: true, result: { executed: false, dry_run: true, handed_off: false } });
    expect([...h.files.keys()].some((k) => k.startsWith("handoff/"))).toBe(false);
  });
  it("requires an authorization source for a real Ready", async () => {
    const h = fakeHost({ node: nodeFake(true, []) });
    expect(await runTool(makeContext(h, "c1", profile), "pr_ready", { repo: "acme/gated-app", pr: 7 })).toMatchObject({ ok: false, errorCode: "AUTHORIZATION_REQUIRED" });
  });
  it("marks Ready, writes the handoff, then refuses replies and further Ready with LANE_HANDED_OFF", async () => {
    const calls: string[] = [];
    const h = fakeHost({ node: nodeFake(true, calls), confirm: true });
    const ctx = makeContext(h, "c1", profile);
    const r = await runTool(ctx, "pr_ready", { repo: "acme/gated-app", pr: 7, authorization_source: "用户 2026-10-04：转 ready", review_entry_evidence: "code-review run 123：进场条件满足" });
    expect(r).toMatchObject({ ok: true, result: { ready: true, handed_off: true } });
    expect(await runTool(ctx, "pr_reply", { repo: "acme/gated-app", pr: 7, target_id: "issue", body: "hi" })).toMatchObject({ ok: false, errorCode: "LANE_HANDED_OFF" });
    expect(await runTool(ctx, "pr_ready", { repo: "acme/gated-app", pr: 7, authorization_source: "again" })).toMatchObject({ ok: false, errorCode: "LANE_HANDED_OFF" });
    expect(calls).not.toContain("pr/reply");
    expect(h.confirms).toHaveLength(0);
  });
  it("an automation lane will not hand off without the review machine's entry evidence", async () => {
    const calls: string[] = [];
    const h = fakeHost({ node: nodeFake(true, calls) });
    const r = await runTool(makeContext(h, "c1", profile), "pr_ready", { repo: "acme/gated-app", pr: 7, authorization_source: "用户 2026-10-04：转 ready" });
    expect(r).toMatchObject({ ok: false, errorCode: "GATE_NOT_MET" });
    expect(calls).not.toContain("pr/ready");
    expect([...h.files.keys()].some((k) => k.startsWith("handoff/"))).toBe(false);
  });
  it("pr_open never pushes a branch whose PR was already handed off", async () => {
    const calls: string[] = [];
    const h = fakeHost({ node: (m, p) => (calls.push(m), m === "pr/resolve" ? { ok: true, result: { repo: "acme/gated-app", number: 7 } } : { ok: true, result: { url: "u", number: 7 } }) });
    await writeHandoff(h, { repo: "acme/gated-app", number: 7, at: "2026-10-04T00:00:00Z", head_sha: "abc", gate: {}, evidence: {} });
    const r = await runTool(makeContext(h, "c1", profile), "pr_open", { repo_dir: "/r", title: "feat: x", sections: "b", push: true, authorization_source: "用户 2026-10-04：提交 PR" });
    expect(r).toMatchObject({ ok: false, errorCode: "LANE_HANDED_OFF" });
    expect(calls).toEqual(["pr/resolve"]);
  });
  it("pr_reply asks for confirmation and respects a decline", async () => {
    const calls: string[] = [];
    const h = fakeHost({ node: nodeFake(true, calls), confirm: false });
    const r = await runTool(makeContext(h, "c1", profile), "pr_reply", { repo: "acme/gated-app", pr: 7, target_id: "issue", body: "hi" });
    expect(r).toMatchObject({ ok: false, errorCode: "USER_DECLINED" });
    expect(h.confirms).toHaveLength(1);
    expect(calls).not.toContain("pr/reply");
  });
  it("pr_status reports stopped_after_handoff for a handed-off PR", async () => {
    const h = fakeHost({ node: nodeFake(true, []) });
    await writeHandoff(h, { repo: "acme/gated-app", number: 7, at: "t", head_sha: "abc", gate: {}, evidence: {} });
    const r = await runTool(makeContext(h, "c1", profile), "pr_status", { repo: "acme/gated-app", pr: 7 });
    expect(r).toMatchObject({ ok: true, result: { handedOff: true, allowedActions: ["stopped_after_handoff"], nextAction: "stopped_after_handoff" } });
  });
});

describe("final-review follow-ups at the tool level", () => {
  it("a ready PR in a labelled lane is not reported mergeable until the label is there", async () => {
    const ready = (labels: string[]) => ({ ...snapshot(true), decision: { kind: "ready" }, pr: { ...pr, isDraft: false, labels }, mergeReadyLabel: labels.includes("review:merge-ready") });
    const run = async (labels: string[]) => runTool(makeContext(fakeHost({ node: () => ({ ok: true, result: ready(labels) }) }), "c1", profile), "pr_status", { repo: "acme/gated-app", pr: 7 });
    expect(await run([])).toMatchObject({ ok: true, result: { mergeable: false } });
    expect(await run(["review:merge-ready"])).toMatchObject({ ok: true, result: { mergeable: true } });
  });
  it("interrogate ingest reports silent or unparseable lanes as gaps", async () => {
    const h = fakeHost();
    const lanes = ["r1", "r2", "r3"].map((label) => ({ label, lane: "reviewer", write: false, working_dir: "/r", branch: null, route: {} }));
    await h.fs({ op: "write", root: "data", path: "fanout/fo-x.json", content: JSON.stringify({ fanout_id: "fo-x", kind: "interrogate", lanes, repo_root: null, task: "t" }) });
    const r: any = await runTool(makeContext(h, "c1", profile), "fanout_ingest", { fanout_id: "fo-x", kind: "interrogate", lane_results: [{ label: "r1", text: "```json\n[]\n```" }, { label: "r2", text: "我看过了，没问题" }] });
    expect(r.ok).toBe(true);
    expect(r.result.complete).toBe(false);
    expect(r.result.gaps.map((g: any) => g.label).sort()).toEqual(["r2", "r3"]);
  });
  it("a keyword-routed start tells the agent to check the routing table", async () => {
    const r: any = await runTool(makeContext(fakeHost(), "c1", profile), "pstack_start", { task: "修一下登录报错" });
    expect(r.ok).toBe(true);
    expect(r.result.next).toContain("路由表核对");
  });
});
