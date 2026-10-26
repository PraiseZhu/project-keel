import { describe, expect, it } from "vitest";
import { allowedActions, draftFor, evaluateGate, resolveLane } from "../src/shared/lanes.ts";
import { LANE_PRESETS, type KeelProfile, type LaneMatch, type LanePreset } from "../src/shared/types.ts";
import { makeContext } from "../src/main/context.ts";
import { runTool } from "../src/main/dispatch.ts";
import { readHandoff, writeHandoff } from "../src/main/handoff.ts";
import { isMergeable } from "../src/main/tools/pr.ts";
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
  it("a ready PR whose Ready gate applies and is unmet cannot hand off or report mergeable", () => {
    const unmet = evaluateGate(gated, ["build"], [], []);
    expect(allowedActions({ rule: gated, decision: "ready", isDraft: false, gate: unmet, handedOff: false })).toEqual(["wait_for_ci"]);
    expect(allowedActions({ rule: LANE_PRESETS.personal, decision: "ready", isDraft: false, gate: evaluateGate(LANE_PRESETS.personal, [], [], []), handedOff: false })).toEqual(["report_mergeable"]);
  });
});

// Tool-level lane enforcement with a fake Node worker.
function makeProfile(lanes: LaneMatch[]): KeelProfile {
  return { lanes, routingPath: null, boardRepos: [], plansDir: null };
}
const pr = { repo: "acme/gated-app", number: 7, url: "https://github.com/acme/gated-app/pull/7", title: "feat: x", state: "OPEN", isDraft: true, headSha: "abc", headRef: "f", baseRef: "main", mergeable: "MERGEABLE", mergeStateStatus: "DRAFT", reviewDecision: null, labels: [] };
function snapshot(gateOk: boolean, preset: LanePreset = "draft-gated-handoff", repo = "acme/gated-app") {
  const rule = LANE_PRESETS[preset];
  const required = preset === "personal" ? [] : ["build"];
  const checks = gateOk && required.length ? [{ name: "build", bucket: "pass" as const }] : [];
  const g = evaluateGate(rule, required, checks, []);
  const draft = preset !== "personal";
  return {
    preset, rule,
    pr: { ...pr, repo, isDraft: draft, mergeStateStatus: draft ? "DRAFT" : "CLEAN" },
    decision: draft ? { kind: "blocker", blocker: "draft-pr" } : { kind: "ready" },
    checks: { failed: [], pending: [], passed: gateOk && required.length ? 1 : 0 },
    unresolvedThreads: 0, gate: g, mergeReadyLabel: false, rendered: "x",
  };
}
function nodeFake(gateOk: boolean, calls: string[], preset: LanePreset = "draft-gated-handoff", repo = "acme/gated-app") {
  return (method: string, params: any) => {
    calls.push(method);
    if (method === "pr/snapshot") return { ok: true, result: snapshot(gateOk, preset, repo) };
    if (method === "pr/ready") {
      const s = snapshot(gateOk, preset, repo);
      const missing = s.gate.ok ? [] : s.gate.missing;
      return {
        ok: true,
        result: {
          gate: { passed: s.gate.ok, missing, required: s.gate.required, sources: [] },
          ready: s.gate.ok && !params.dry_run,
          executed: s.gate.ok && !params.dry_run,
          head_sha: "abc",
          ...(params.dry_run ? { would_mark_ready: s.gate.ok && s.pr.isDraft } : {}),
        },
      };
    }
    if (method === "pr/reply") return { ok: true, result: { posted: true } };
    if (method === "pr/resolve") return { ok: true, result: { repo, number: 7 } };
    if (method === "pr/open") return { ok: true, result: { url: "u", number: 7 } };
    return { ok: false, message: "UNEXPECTED: " + method };
  };
}
const at = (min: number) => new Date(Date.UTC(2026, 9, 4, 12, 0) - min * 60_000).toISOString();
const validEntry = { head_sha: "abc", checked_at: at(5), result: "pass", source: "code-review.yml 窗口检查" };
const auth = "用户 2026-10-04：转 ready";
const handoffSwitchOff: Array<{ name: string; repo: string; preset: LanePreset; extra: Partial<LaneMatch> }> = [
  { name: "default draft-gated-handoff", repo: "acme/gated-app", preset: "draft-gated-handoff", extra: {} },
  { name: "false draft-gated-handoff", repo: "acme/gated-app", preset: "draft-gated-handoff", extra: { requireReviewEntry: false } },
  { name: "default gated-handoff", repo: "acme/client", preset: "gated-handoff", extra: {} },
  { name: "false gated-handoff", repo: "acme/client", preset: "gated-handoff", extra: { requireReviewEntry: false } },
];

describe("pr_ready / pr_reply lane enforcement", () => {
  it("returns GATE_NOT_MET when required checks are missing or not passing", async () => {
    const calls: string[] = [];
    const h = fakeHost({ node: nodeFake(false, calls) });
    const r = await runTool(makeContext(h, "c1", profile), "pr_ready", { repo: "acme/gated-app", pr: 7, authorization_source: auth });
    expect(r).toMatchObject({ ok: false, errorCode: "GATE_NOT_MET" });
    expect((r as { data?: { missing?: string[] } }).data?.missing?.join()).toContain("build");
    expect((r as { data?: { missing?: string[] } }).data?.missing?.join()).not.toContain("review_entry");
  });
  it("dry_run evaluates only and never hands off", async () => {
    const calls: string[] = [];
    const h = fakeHost({ node: nodeFake(true, calls) });
    const r: any = await runTool(makeContext(h, "c1", profile), "pr_ready", { repo: "acme/gated-app", pr: 7, dry_run: true });
    expect(r).toMatchObject({ ok: true, result: { executed: false, dry_run: true, handed_off: false, would_mark_ready: true } });
    expect(r.result.gate.passed).toBe(true);
    expect(r.result.gate.missing.join()).not.toContain("review_entry");
    expect([...h.files.keys()].some((k) => k.startsWith("handoff/"))).toBe(false);
  });
  it("requires an authorization source for a real Ready", async () => {
    const h = fakeHost({ node: nodeFake(true, []) });
    expect(await runTool(makeContext(h, "c1", profile), "pr_ready", { repo: "acme/gated-app", pr: 7 })).toMatchObject({ ok: false, errorCode: "AUTHORIZATION_REQUIRED" });
  });
  it("marks Ready, writes a complete handoff without review_entry, then refuses replies and further Ready", async () => {
    const calls: string[] = [];
    const h = fakeHost({ node: nodeFake(true, calls), confirm: true });
    const ctx = makeContext(h, "c1", profile);
    const r: any = await runTool(ctx, "pr_ready", { repo: "acme/gated-app", pr: 7, authorization_source: auth });
    expect(r).toMatchObject({ ok: true, result: { ready: true, handed_off: true, handoff: { status: "complete" } } });
    expect(r.result).not.toHaveProperty("review_entry");
    expect(r.result.handoff.evidence.review_entry).toBeNull();
    expect((await readHandoff(h, "acme/gated-app", 7))?.status).toBe("complete");
    expect(await runTool(ctx, "pr_reply", { repo: "acme/gated-app", pr: 7, target_id: "issue", body: "hi" })).toMatchObject({ ok: false, errorCode: "LANE_HANDED_OFF" });
    expect(await runTool(ctx, "pr_ready", { repo: "acme/gated-app", pr: 7, authorization_source: "again" })).toMatchObject({ ok: false, errorCode: "LANE_HANDED_OFF" });
    expect(calls).not.toContain("pr/reply");
    expect(h.confirms).toHaveLength(0);
  });
  it.each(handoffSwitchOff)("$name hands off without review_entry", async ({ repo, preset, extra }) => {
    const calls: string[] = [];
    const h = fakeHost({ node: nodeFake(true, calls, preset, repo) });
    const ctx = makeContext(h, "c1", makeProfile([{ repo, preset, ...extra }]));
    const r: any = await runTool(ctx, "pr_ready", { repo, pr: 7, authorization_source: auth });
    expect(r).toMatchObject({ ok: true, result: { ready: true, handed_off: true, handoff: { status: "complete" } } });
    expect(r.result.gate.missing.join()).not.toContain("review_entry");
    expect((await readHandoff(h, repo, 7))?.status).toBe("complete");
    expect(calls).toContain("pr/ready");
  });
  it.each(handoffSwitchOff)("$name dry_run omits review_entry from missing and writes nothing", async ({ repo, preset, extra }) => {
    const calls: string[] = [];
    const h = fakeHost({ node: nodeFake(true, calls, preset, repo) });
    const r: any = await runTool(makeContext(h, "c1", makeProfile([{ repo, preset, ...extra }])), "pr_ready", { repo, pr: 7, dry_run: true });
    expect(r).toMatchObject({ ok: true, result: { executed: false, dry_run: true, handed_off: false, would_mark_ready: true } });
    expect(r.result.gate.passed).toBe(true);
    expect(r.result.gate.missing.join()).not.toContain("review_entry");
    expect([...h.files.keys()].some((k) => k.startsWith("handoff/"))).toBe(false);
    expect(calls).toContain("pr/ready");
  });
  it("ignores bad review_entry when the switch is off", async () => {
    const calls: string[] = [];
    const h = fakeHost({ node: nodeFake(true, calls) });
    const r: any = await runTool(makeContext(h, "c1", profile), "pr_ready", {
      repo: "acme/gated-app", pr: 7, authorization_source: auth,
      review_entry: { ...validEntry, result: "fail", head_sha: "old", checked_at: at(45), source: "" },
    });
    expect(r).toMatchObject({ ok: true, result: { ready: true, handed_off: true } });
    expect(r.result).not.toHaveProperty("review_entry");
    expect(calls).toContain("pr/ready");
  });
  it("push-class calls after a no-evidence handoff return LANE_HANDED_OFF", async () => {
    const calls: string[] = [];
    const h = fakeHost({ node: nodeFake(true, calls) });
    const ctx = makeContext(h, "c1", profile);
    expect(await runTool(ctx, "pr_ready", { repo: "acme/gated-app", pr: 7, authorization_source: auth })).toMatchObject({ ok: true, result: { handed_off: true } });
    const open = await runTool(ctx, "pr_open", { repo_dir: "/r", title: "feat: x", sections: "b", push: true, authorization_source: "用户 2026-10-04：提交 PR" });
    expect(open).toMatchObject({ ok: false, errorCode: "LANE_HANDED_OFF" });
    expect(calls).not.toContain("pr/open");
  });
  it("personal lane marks Ready without a handoff record, even if requireReviewEntry is true", async () => {
    for (const extra of [{}, { requireReviewEntry: true }]) {
      const calls: string[] = [];
      const h = fakeHost({ node: nodeFake(true, calls, "personal", "acme/personal") });
      const r: any = await runTool(makeContext(h, "c1", makeProfile([{ repo: "acme/personal", preset: "personal", ...extra }])), "pr_ready", {
        repo: "acme/personal", pr: 7, authorization_source: auth,
      });
      expect(r).toMatchObject({ ok: true, result: { ready: true, handed_off: false, handoff: null } });
      expect(r.result.gate.missing.join()).not.toContain("review_entry");
      expect([...h.files.keys()].some((k) => k.startsWith("handoff/"))).toBe(false);
      expect(calls).toContain("pr/ready");
    }
  });
  it("an automation lane with requireReviewEntry true will not hand off without the review machine's entry evidence", async () => {
    const calls: string[] = [];
    const on = makeProfile([{ repo: "acme/gated-app", preset: "draft-gated-handoff", requireReviewEntry: true }]);
    const h = fakeHost({ node: nodeFake(true, calls) });
    const r = await runTool(makeContext(h, "c1", on), "pr_ready", { repo: "acme/gated-app", pr: 7, authorization_source: auth });
    expect(r).toMatchObject({ ok: false, errorCode: "GATE_NOT_MET" });
    expect((r as { data?: { missing?: string[] } }).data?.missing).toEqual(["review_entry"]);
    expect(calls).not.toContain("pr/ready");
    expect([...h.files.keys()].some((k) => k.startsWith("handoff/"))).toBe(false);
  });
  it("bad entry evidence blocks Ready and is listed even in a dry run when the switch is on", async () => {
    const on = makeProfile([{ repo: "acme/gated-app", preset: "draft-gated-handoff", requireReviewEntry: true }]);
    for (const bad of [{ ...validEntry, result: "fail" }, { ...validEntry, result: "" }, { ...validEntry, head_sha: "old" }, { ...validEntry, checked_at: at(45) }, { ...validEntry, source: "" }]) {
      const calls: string[] = [];
      const h = fakeHost({ node: nodeFake(true, calls) });
      const r = await runTool(makeContext(h, "c1", on), "pr_ready", { repo: "acme/gated-app", pr: 7, authorization_source: auth, review_entry: bad });
      expect(r).toMatchObject({ ok: false, errorCode: "GATE_NOT_MET" });
      expect(calls).not.toContain("pr/ready");
      expect([...h.files.keys()].some((k) => k.startsWith("handoff/"))).toBe(false);
    }
    const dryCalls: string[] = [];
    const dry: any = await runTool(makeContext(fakeHost({ node: nodeFake(true, dryCalls) }), "c1", on), "pr_ready", { repo: "acme/gated-app", pr: 7, dry_run: true });
    expect(dry.result.gate.passed).toBe(false);
    expect(dry.result.gate.missing.join()).toContain("review_entry");
    expect(dryCalls).toContain("pr/ready");
  });
  it("valid evidence on a requireReviewEntry lane hands off and binds expected_head", async () => {
    const seen: any[] = [];
    const on = makeProfile([{ repo: "acme/gated-app", preset: "draft-gated-handoff", requireReviewEntry: true }]);
    const h = fakeHost({ node: (m, p) => (m === "pr/ready" && seen.push(p), nodeFake(true, [])(m, p)) });
    const r: any = await runTool(makeContext(h, "c1", on), "pr_ready", { repo: "acme/gated-app", pr: 7, authorization_source: auth, review_entry: validEntry });
    expect(r).toMatchObject({ ok: true, result: { ready: true, handed_off: true, handoff: { status: "complete" } } });
    expect(r.result.review_entry.ok).toBe(true);
    expect(seen[0]).toMatchObject({ expected_head: "abc" });
  });
  it("Ready still sends expected_head when the switch is off", async () => {
    const seen: any[] = [];
    const h = fakeHost({ node: (m, p) => (m === "pr/ready" && seen.push(p), nodeFake(true, [])(m, p)) });
    await runTool(makeContext(h, "c1", profile), "pr_ready", { repo: "acme/gated-app", pr: 7, authorization_source: auth });
    expect(seen[0]).toMatchObject({ expected_head: "abc" });
  });
  it("pr_open refuses to push when the PR lookup itself fails", async () => {
    const calls: string[] = [];
    const h = fakeHost({ node: (m) => (calls.push(m), m === "pr/resolve" ? { ok: false, errorCode: "GH_ERROR", message: "GH_ERROR: HTTP 502" } : { ok: true, result: {} }) });
    const r = await runTool(makeContext(h, "c1", profile), "pr_open", { repo_dir: "/r", title: "feat: x", sections: "b", push: true, authorization_source: "用户 2026-10-04：提交 PR" });
    expect(r.ok).toBe(false);
    expect(calls).toEqual(["pr/resolve"]);
  });
  it("pr_open never pushes a branch whose PR was already handed off", async () => {
    const calls: string[] = [];
    const h = fakeHost({ node: (m, p) => (calls.push(m), m === "pr/resolve" ? { ok: true, result: { repo: "acme/gated-app", number: 7 } } : { ok: true, result: { url: "u", number: 7 } }) });
    await writeHandoff(h, { repo: "acme/gated-app", number: 7, at: "2026-10-04T00:00:00Z", head_sha: "abc", gate: {}, evidence: {} });
    const r = await runTool(makeContext(h, "c1", profile), "pr_open", { repo_dir: "/r", title: "feat: x", sections: "b", push: true, authorization_source: "用户 2026-10-04：提交 PR" });
    expect(r).toMatchObject({ ok: false, errorCode: "LANE_HANDED_OFF" });
    expect(calls).toEqual(["pr/resolve"]);
  });
  it("pr_reply in confirm mode asks for confirmation and respects a decline", async () => {
    const calls: string[] = [];
    const h = fakeHost({ node: nodeFake(true, calls), confirm: false, kv: { replyConfirm: "confirm" } });
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
  it("isMergeable is false when the Ready gate applies and is unmet", () => {
    const unmet = evaluateGate(gated, ["build"], [], []);
    const readySnap = { decision: { kind: "ready" as const }, rule: gated, mergeReadyLabel: true, pr: { ...pr, isDraft: false, labels: ["review:merge-ready"] }, gate: unmet };
    expect(isMergeable(readySnap as Parameters<typeof isMergeable>[0])).toBe(false);
    expect(isMergeable({ ...readySnap, gate: evaluateGate(gated, ["build"], [{ name: "build", bucket: "pass" }], []) } as Parameters<typeof isMergeable>[0])).toBe(true);
  });
  it("pr_status does not report mergeable or handoff when the Ready gate applies and is unmet", async () => {
    const unmet = snapshot(false);
    const r: any = await runTool(makeContext(fakeHost({ node: () => ({ ok: true, result: { ...unmet, decision: { kind: "ready" }, pr: { ...pr, isDraft: false } } }) }), "c1", profile), "pr_status", { repo: "acme/gated-app", pr: 7 });
    expect(r).toMatchObject({ ok: true, result: { mergeable: false, allowedActions: ["wait_for_ci"], nextAction: "wait_for_ci" } });
  });
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
    const r: any = await runTool(makeContext(h, "c1", profile), "fanout", { op: "ingest", fanout_id: "fo-x", kind: "interrogate", lane_results: [{ label: "r1", text: "```json\n[]\n```" }, { label: "r2", text: "我看过了，没问题" }] });
    expect(r.ok).toBe(true);
    expect(r.result.complete).toBe(false);
    expect(r.result.gaps.map((g: any) => g.label).sort()).toEqual(["r2", "r3"]);
    const saved = JSON.parse(h.files.get("fanout/fo-x.json")!);
    expect(saved.status).toMatchObject({ complete: false, gaps: 2 });
    expect(saved.reported).toEqual(["r1", "r2"]);
  });
  it("an error object or findings without file/title are gaps, not zero findings", async () => {
    const h = fakeHost();
    const lanes = ["r1", "r2"].map((label) => ({ label, lane: "reviewer", write: false, working_dir: "/r", branch: null, route: {} }));
    await h.fs({ op: "write", root: "data", path: "fanout/fo-y.json", content: JSON.stringify({ fanout_id: "fo-y", kind: "interrogate", lanes, repo_root: null, task: "t" }) });
    const r: any = await runTool(makeContext(h, "c1", profile), "fanout", { op: "ingest", fanout_id: "fo-y", kind: "interrogate", lane_results: [{ label: "r1", text: '```json\n{"error":"review failed"}\n```' }, { label: "r2", text: '```json\n[{"severity_guess":"P1","impact":"core broken"}]\n```' }] });
    expect(r.result.complete).toBe(false);
    expect(r.result.gaps.map((g: any) => g.label).sort()).toEqual(["r1", "r2"]);
  });
  it("pstack_start as a migration entry requires repo_dir", async () => {
    const r: any = await runTool(makeContext(fakeHost(), "c1", profile), "pstack_start", { task: "修一下登录报错" });
    expect(r).toMatchObject({ ok: false, errorCode: "INVALID_INPUT" });
    expect(r.message).toContain("repo_dir");
  });
});
