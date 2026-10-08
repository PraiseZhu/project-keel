import { describe, expect, it } from "vitest";
import { makeContext } from "../src/main/context.ts";
import { runTool } from "../src/main/dispatch.ts";
import { writeHandoff } from "../src/main/handoff.ts";
import { readReplyMode, saveReplyMode } from "../src/panel/reply-setting.ts";
import type { KeelProfile } from "../src/shared/types.ts";
import { fakeHost } from "./helpers/fakeHost.ts";

const profile: KeelProfile = { lanes: [{ repo: "acme/app", preset: "personal" }], routingPath: null, boardRepos: [], plansDir: null };

function nodeFake(calls: string[]) {
  return async (method: string) => {
    calls.push(method);
    if (method === "pr/snapshot") return { ok: true, result: { pr: { repo: "acme/app", number: 7, state: "OPEN", isDraft: false, headSha: "abc", labels: [] } } };
    if (method === "pr/reply") return { ok: true, result: { posted: true, url: "https://github.com/acme/app/pull/7#c1", resolved: true } };
    return { ok: true, result: {} };
  };
}

describe("pr_reply replyConfirm", () => {
  it("posts directly by default without a confirm prompt", async () => {
    const calls: string[] = [];
    const h = fakeHost({ node: nodeFake(calls) as never });
    const r = await runTool(makeContext(h, "c1", profile), "pr_reply", { repo: "acme/app", pr: 7, target_id: "PRRT_x", body: "hi", resolve: true });
    expect(r).toMatchObject({ ok: true, result: { posted: true } });
    expect(h.confirms).toHaveLength(0);
    expect(calls).toContain("pr/reply");
  });

  it("asks per reply in confirm mode and respects a decline", async () => {
    const calls: string[] = [];
    const h = fakeHost({ node: nodeFake(calls) as never, confirm: false, kv: { replyConfirm: "confirm" } });
    const r = await runTool(makeContext(h, "c1", profile), "pr_reply", { repo: "acme/app", pr: 7, target_id: "issue", body: "hi" });
    expect(r).toMatchObject({ ok: false, errorCode: "USER_DECLINED" });
    expect(h.confirms).toHaveLength(1);
    expect(calls).not.toContain("pr/reply");
  });

  it("rejects an invalid replyConfirm instead of silently posting", async () => {
    const calls: string[] = [];
    const h = fakeHost({ node: nodeFake(calls) as never, kv: { replyConfirm: "sometimes" } });
    const r = await runTool(makeContext(h, "c1", profile), "pr_reply", { repo: "acme/app", pr: 7, target_id: "issue", body: "hi" });
    expect(r).toMatchObject({ ok: false, errorCode: "REPLY_CONFIG_INVALID" });
    expect(calls).not.toContain("pr/reply");
  });

  it("still refuses a handed-off PR in auto mode", async () => {
    const calls: string[] = [];
    const gated: KeelProfile = { ...profile, lanes: [{ repo: "acme/app", preset: "gated-handoff" }] };
    const h = fakeHost({ node: nodeFake(calls) as never });
    await writeHandoff(h, { repo: "acme/app", number: 7, at: "2026-10-08T00:00:00Z", head_sha: "abc", gate: {}, evidence: {} });
    const r = await runTool(makeContext(h, "c1", gated), "pr_reply", { repo: "acme/app", pr: 7, target_id: "issue", body: "hi" });
    expect(r).toMatchObject({ ok: false, errorCode: "LANE_HANDED_OFF" });
    expect(calls).not.toContain("pr/reply");
  });
});

describe("settings reply mode", () => {
  it("reads the default and flags an invalid value", () => {
    expect(readReplyMode({})).toEqual({ mode: "auto" });
    expect(readReplyMode({ replyConfirm: "confirm" })).toEqual({ mode: "confirm" });
    expect(readReplyMode({ replyConfirm: 3 }).error).toMatch(/非法/);
  });

  it("merges into existing kv and reports write failures", async () => {
    let stored: Record<string, unknown> = { manual: { v: 1 } };
    const io = {
      getKv: async () => ({ ...stored }),
      putKv: async (kv: Record<string, unknown>) => { stored = kv; return { ok: true, status: 204 }; },
    } as never;
    expect(await saveReplyMode(io, "confirm")).toEqual({ ok: true });
    expect(stored).toEqual({ manual: { v: 1 }, replyConfirm: "confirm" });
    const failing = { getKv: async () => ({}), putKv: async () => ({ ok: false, status: 500 }) } as never;
    expect(await saveReplyMode(failing, "auto")).toEqual({ ok: false, message: "写入 /kv 失败（HTTP 500）。" });
  });
});
