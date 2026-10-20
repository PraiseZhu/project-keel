import { describe, expect, it } from "vitest";
import { makeContext } from "../src/main/context.ts";
import { runTool } from "../src/main/dispatch.ts";
import { fakeHost, typesafeAnswering } from "./helpers/fakeHost.ts";

function thread(id: string, body: string) {
  return { id, author: "reviewer", path: "src/a.ts", line: 10, body, is_bot: false };
}

function hostWithThreads(
  threads: ReturnType<typeof thread>[],
  fetch?: ReturnType<typeof typesafeAnswering>,
) {
  return fakeHost({
    ...(fetch ? { fetch } : {}),
    node: (method: string) => {
      if (method === "pr/threads") return { ok: true, result: { repo: "acme/app", number: 12, threads } };
      return { ok: false, message: "no node" };
    },
  });
}

async function runThreads(h: ReturnType<typeof fakeHost>) {
  return runTool(makeContext(h, "c"), "pr_threads", {});
}

describe("pr_threads", () => {
  it("marks high-confidence P0/P1/P2 as fix candidates and P3/not_real as record-only", async () => {
    const choices = ["P0", "P1", "P2", "P3", "not_real"];
    const h = hostWithThreads(
      choices.map((sev, i) => thread(`t${i}`, `finding ${sev}`)),
      typesafeAnswering(0.9, (id) => choices[Number(id.split("_").pop())]!),
    );
    const r: any = await runThreads(h);
    expect(r.ok).toBe(true);
    expect(r.result.triage.map((x: any) => [x.severity, x.fix])).toEqual([
      ["P0", "候选修复：补齐触发条件、错误行为、影响与证据后才进入修复清单"],
      ["P1", "候选修复：补齐触发条件、错误行为、影响与证据后才进入修复清单"],
      ["P2", "候选修复：补齐触发条件、错误行为、影响与证据后才进入修复清单"],
      ["P3", "记录不修（P3/不成立）"],
      ["not_real", "记录不修（P3/不成立）"],
    ]);
    expect(r.result.summary).toContain("只修确认成立的 P0/P1/P2（P3 不修）");
  });

  it("treats P2 at 0.75 as a candidate and P2 at 0.6 as unverified", async () => {
    const high = hostWithThreads([thread("t-high", "local defect")], typesafeAnswering(0.75, () => "P2"));
    const low = hostWithThreads([thread("t-low", "local defect")], typesafeAnswering(0.6, () => "P2"));
    const highR: any = await runThreads(high);
    const lowR: any = await runThreads(low);
    expect(highR.result.triage[0]).toMatchObject({
      severity: "P2",
      fix: "候选修复：补齐触发条件、错误行为、影响与证据后才进入修复清单",
    });
    expect(lowR.result.triage[0]).toMatchObject({ severity: null, fix: "待核实（Jev 低于阈值或不可用）" });
  });

  it("keeps unverified status and fallback_reason when Jev is unavailable", async () => {
    const h = hostWithThreads([thread("t1", "maybe a bug")]);
    const r: any = await runThreads(h);
    expect(r.ok).toBe(true);
    expect(r.result.triage[0]).toMatchObject({ severity: null, fix: "待核实（Jev 低于阈值或不可用）" });
    expect(r.result.fallback_reason).toBeTruthy();
  });

  it("does not call Jev when there are no threads", async () => {
    const h = hostWithThreads([], typesafeAnswering(0.9, () => "P1"));
    const r: any = await runThreads(h);
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ triage: [], summary: "没有未解决的评审线程。" });
    expect(h.fetches).toHaveLength(0);
  });
});
