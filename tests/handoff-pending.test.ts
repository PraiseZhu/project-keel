import { describe, expect, it } from "vitest";
import { evaluateGate } from "../src/shared/lanes.ts";
import { LANE_PRESETS, type KeelProfile } from "../src/shared/types.ts";
import { makeContext } from "../src/main/context.ts";
import { runTool } from "../src/main/dispatch.ts";
import { readHandoff, writeHandoff } from "../src/main/handoff.ts";
import { fakeHost } from "./helpers/fakeHost.ts";

const profile: KeelProfile = {
  lanes: [{ repo: "acme/gated-app", preset: "draft-gated-handoff" }],
  routingPath: null, boardRepos: [], plansDir: null,
};
const gated = LANE_PRESETS["draft-gated-handoff"];
const pr = { repo: "acme/gated-app", number: 7, url: "https://github.com/acme/gated-app/pull/7", title: "feat: x", state: "OPEN", isDraft: true, headSha: "abc", headRef: "f", baseRef: "main", mergeable: "MERGEABLE", mergeStateStatus: "DRAFT", reviewDecision: null, labels: [] };

function snapshot(gateOk: boolean, extra: Record<string, unknown> = {}) {
  const g = evaluateGate(gated, ["build"], gateOk ? [{ name: "build", bucket: "pass" }] : [], []);
  return {
    preset: "draft-gated-handoff", rule: gated, pr, decision: { kind: "blocker", blocker: "draft-pr" },
    checks: { failed: [], pending: [], passed: gateOk ? 1 : 0 }, unresolvedThreads: 0, gate: g,
    mergeReadyLabel: false, rendered: "x", ...extra,
  };
}

const entry = { head_sha: "abc", checked_at: new Date(Date.UTC(2026, 9, 4, 11, 50)).toISOString(), result: "pass", source: "code-review.yml 窗口检查" };

describe("pending-first handoff", () => {
  it("writes pending before Ready and marks the record complete after success", async () => {
    const order: string[] = [];
    const h = fakeHost({
      node: (m, p) => {
        order.push(m);
        if (m === "pr/snapshot") return { ok: true, result: snapshot(true) };
        if (m === "pr/ready") {
          const rec = [...h.files.keys()].find((k) => k.startsWith("handoff/"));
          expect(rec).toBeTruthy();
          expect(JSON.parse(h.files.get(rec!)!).status).toBe("pending");
          return { ok: true, result: { gate: { passed: true, missing: [], required: ["build"], sources: [] }, ready: true, executed: true, head_sha: "abc" } };
        }
        return { ok: false, message: "UNEXPECTED " + m + JSON.stringify(p) };
      },
    });
    const r = await runTool(makeContext(h, "c1", profile), "pr_ready", {
      repo: "acme/gated-app", pr: 7, authorization_source: "用户 2026-10-04：转 ready", review_entry: entry,
    });
    expect(r).toMatchObject({ ok: true, result: { ready: true, handed_off: true } });
    expect(order).toEqual(["pr/snapshot", "pr/ready"]);
    const rec = await readHandoff(h, "acme/gated-app", 7);
    expect(rec?.status).toBe("complete");
  });

  it("keeps the record pending when Ready fails, and does not treat it as handed off", async () => {
    const h = fakeHost({
      node: (m) => {
        if (m === "pr/snapshot") return { ok: true, result: snapshot(true) };
        if (m === "pr/ready") return { ok: true, result: { gate: { passed: false, missing: ["build（进行中）"], required: ["build"], sources: [] }, ready: false, executed: false, head_sha: "abc" } };
        return { ok: false, message: "UNEXPECTED " + m };
      },
    });
    const r = await runTool(makeContext(h, "c1", profile), "pr_ready", {
      repo: "acme/gated-app", pr: 7, authorization_source: "用户 2026-10-04：转 ready", review_entry: entry,
    });
    expect(r).toMatchObject({ ok: false, errorCode: "GATE_NOT_MET" });
    const rec = await readHandoff(h, "acme/gated-app", 7);
    expect(rec?.status).toBe("pending");
    const status = await runTool(makeContext(h, "c1", profile), "pr_status", { repo: "acme/gated-app", pr: 7 });
    expect(status).toMatchObject({ ok: true, result: { handedOff: false } });
    expect((status as { result: { allowedActions: string[] } }).result.allowedActions).not.toContain("stopped_after_handoff");
  });

  it("reconciles a leftover pending record to complete when GitHub is already Ready", async () => {
    const h = fakeHost({
      node: () => ({
        ok: true,
        result: snapshot(true, { decision: { kind: "ready" }, pr: { ...pr, isDraft: false } }),
      }),
    });
    await writeHandoff(h, {
      repo: "acme/gated-app", number: 7, at: "2026-10-04T11:00:00.000Z", head_sha: "abc",
      gate: {}, evidence: {}, status: "pending", was_draft: true,
    });
    const r = await runTool(makeContext(h, "c1", profile), "pr_status", { repo: "acme/gated-app", pr: 7 });
    expect(r).toMatchObject({ ok: true, result: { handedOff: true, allowedActions: ["stopped_after_handoff"] } });
    expect((await readHandoff(h, "acme/gated-app", 7))?.status).toBe("complete");
  });

  it("a pending record does not block a retry", async () => {
    const h = fakeHost({
      node: (m) => {
        if (m === "pr/snapshot") return { ok: true, result: snapshot(true) };
        if (m === "pr/ready") return { ok: true, result: { gate: { passed: true, missing: [], required: ["build"], sources: [] }, ready: true, executed: true, head_sha: "abc" } };
        return { ok: false, message: "UNEXPECTED " + m };
      },
    });
    await writeHandoff(h, {
      repo: "acme/gated-app", number: 7, at: "t", head_sha: "abc", gate: {}, evidence: {}, status: "pending", was_draft: true,
    });
    const r = await runTool(makeContext(h, "c1", profile), "pr_ready", {
      repo: "acme/gated-app", pr: 7, authorization_source: "用户 2026-10-04：转 ready", review_entry: entry,
    });
    expect(r).toMatchObject({ ok: true, result: { ready: true, handed_off: true } });
    expect((await readHandoff(h, "acme/gated-app", 7))?.status).toBe("complete");
  });
});
