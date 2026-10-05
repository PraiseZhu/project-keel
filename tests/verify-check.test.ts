import { describe, expect, it } from "vitest";
import { allowedActions, evaluateGate, verificationOf } from "../src/shared/lanes.ts";
import { LANE_PRESETS, type KeelProfile, type Verification } from "../src/shared/types.ts";
import { readyVerdict } from "../src/node/pr/actions.ts";
import { renderZh } from "../src/node/pr/snapshot.ts";
import { makeContext } from "../src/main/context.ts";
import { runTool } from "../src/main/dispatch.ts";
import { fakeHost } from "./helpers/fakeHost.ts";
import { passingCheck, pendingCheck } from "./helpers/upstream-fakes.ts";

const personal = LANE_PRESETS.personal;
const noGate = evaluateGate(personal, [], [], []);
const missing: Verification = { check: "agent-verify", state: "missing" };
const passed: Verification = { check: "agent-verify", state: "pass" };

describe("verify status on the current head", () => {
  it("reads the lane's verify check from the head's real check list", () => {
    const failed = { ...passingCheck("agent-verify"), kind: "failed" as const };
    expect(verificationOf("agent-verify", [passingCheck("build"), passingCheck("agent-verify")]).state).toBe("pass");
    expect(verificationOf("agent-verify", [failed]).state).toBe("failing");
    expect(verificationOf("agent-verify", [pendingCheck("agent-verify")]).state).toBe("pending");
    expect(verificationOf("agent-verify", [passingCheck("build")]).state).toBe("missing");
    expect(verificationOf("agent-verify", []).state).toBe("missing");
  });

  it("an unverified ready PR has exactly one next step: verify it", () => {
    expect(allowedActions({ rule: personal, decision: "ready", isDraft: false, gate: noGate, handedOff: false, verified: false })).toEqual(["verify_current_head"]);
    expect(allowedActions({ rule: LANE_PRESETS["gated-handoff"], decision: "ready", isDraft: false, gate: noGate, handedOff: false, verified: false })).toEqual(["verify_current_head"]);
    expect(allowedActions({ rule: personal, decision: "blocker", blocker: "draft-pr", isDraft: true, gate: noGate, handedOff: false, verified: false })).toEqual(["verify_current_head"]);
  });

  it("lanes without a verify check, or with a passing one, behave as before", () => {
    expect(allowedActions({ rule: personal, decision: "ready", isDraft: false, gate: noGate, handedOff: false })).toEqual(["report_mergeable"]);
    expect(allowedActions({ rule: personal, decision: "ready", isDraft: false, gate: noGate, handedOff: false, verified: true })).toEqual(["report_mergeable"]);
    expect(allowedActions({ rule: personal, decision: "waiting", isDraft: false, gate: noGate, handedOff: false, verified: false })).toEqual(["wait_for_ci"]);
    expect(allowedActions({ rule: personal, decision: "ready", isDraft: false, gate: noGate, handedOff: true, verified: false })).toEqual(["stopped_after_handoff"]);
  });

  it("Ready is refused until the verify status passes, without listing it twice", () => {
    const green = { gate: noGate, decision: { kind: "blocker" as const, blocker: "draft-pr" }, checks: { failed: [], pending: [], passed: 1 } };
    expect(readyVerdict({ ...green, verification: missing } as any)).toEqual({ passed: false, missing: ["agent-verify（当前提交未验证）"] });
    const running = readyVerdict({ ...green, checks: { failed: [], pending: ["agent-verify"], passed: 1 }, verification: { check: "agent-verify", state: "pending" } } as any);
    expect(running.passed).toBe(false);
    expect(running.missing).toEqual(["agent-verify（进行中）"]);
    expect(readyVerdict({ ...green, verification: passed } as any)).toEqual({ passed: true, missing: [] });
    expect(readyVerdict({ ...green, verification: null } as any)).toEqual({ passed: true, missing: [] });
  });

  it("the Chinese status line says an unverified PR is not mergeable", () => {
    const pr = { repo: "acme/solo", number: 3, title: "fix: x", labels: [] } as any;
    const text = renderZh({ pr, decision: { kind: "ready" }, checks: { failed: [], pending: [], passed: 2 }, unresolvedThreads: 0, gate: noGate, preset: "personal", verification: missing });
    expect(text).toContain("验证前不算可合并");
    expect(text).toContain("验证状态 agent-verify：当前提交还没有");
    expect(text).not.toContain("可合并（请在 GitHub 合并");
  });
});

// Tool level, with a fake Node worker.
const profile: KeelProfile = { lanes: [{ repo: "acme/solo", preset: "personal", verifyCheck: "agent-verify" }], routingPath: null, boardRepos: [], plansDir: null };
const pr = { repo: "acme/solo", number: 3, url: "https://github.com/acme/solo/pull/3", title: "fix: x", state: "OPEN", isDraft: false, headSha: "abc123def456789", headRef: "f", baseRef: "main", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, labels: [] };
function snap(verification: Verification) {
  return { preset: "personal", rule: personal, pr, decision: { kind: "ready" }, checks: { failed: [], pending: [], passed: 1 }, unresolvedThreads: 0, gate: noGate, verification, mergeReadyLabel: false, rendered: "x" };
}
function nodeFake(verification: Verification) {
  return (method: string) => {
    if (method === "pr/snapshot") return { ok: true, result: snap(verification) };
    if (method === "pr/ready") {
      const ok = verification.state === "pass";
      return { ok: true, result: { gate: { passed: ok, missing: ok ? [] : ["agent-verify（当前提交未验证）"], required: [], sources: [] }, ready: ok, executed: false, head_sha: pr.headSha } };
    }
    return { ok: false, message: "UNEXPECTED: " + method };
  };
}

describe("pr_status / pr_ready with a verify check", () => {
  it("pr_status points at a non-author verifier and gives the author no status command", async () => {
    const r: any = await runTool(makeContext(fakeHost({ node: nodeFake(missing) }), "c1", profile), "pr_status", { repo: "acme/solo", pr: 3 });
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ nextAction: "verify_current_head", allowedActions: ["verify_current_head"], mergeable: false });
    expect(r.result.merge_hint).toContain("fanout_plan");
    // The author's hint must not carry a ready-made status write: that would let the author skip the verifier.
    expect(r.result.merge_hint).toContain("作者不要自己写这个状态");
    expect(r.result.merge_hint).not.toContain("gh api");
    expect(r.result.merge_hint).not.toContain("state=success");
  });

  it("pr_status reports mergeable once the current head is verified", async () => {
    const r: any = await runTool(makeContext(fakeHost({ node: nodeFake(passed) }), "c1", profile), "pr_status", { repo: "acme/solo", pr: 3 });
    expect(r.result).toMatchObject({ nextAction: "report_mergeable", mergeable: true });
    expect(r.result.merge_hint).toContain("可合并");
  });

  it("pr_ready refuses an unverified head and says what to do next", async () => {
    const r: any = await runTool(makeContext(fakeHost({ node: nodeFake(missing) }), "c1", profile), "pr_ready", { repo: "acme/solo", pr: 3, authorization_source: "用户 2026-10-06：转 ready" });
    expect(r).toMatchObject({ ok: false, errorCode: "GATE_NOT_MET" });
    expect(r.message).toContain("agent-verify（当前提交未验证）");
    expect(r.message).toContain("派一个不是作者的模型验证这一版");
    expect(r.message).not.toContain("gh api");
  });
});
