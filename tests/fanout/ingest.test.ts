import { describe, expect, it } from "vitest";
import { classifyAgreement, crossJudge, dedupe, findingsOf, swarmRow } from "../../src/main/fanout/ingest.ts";
import { makeContext } from "../../src/main/context.ts";
import { runTool } from "../../src/main/dispatch.ts";
import { fakeHost, typesafeAnswering } from "../helpers/fakeHost.ts";

const r1 = 'Findings:\n```json\n[{"file":"src/a.ts","line":10,"title":"Null deref when user missing","severity_guess":"P1"},{"file":"src/b.ts","line":3,"title":"Typo in comment","severity_guess":"P3"}]\n```';
const r2 = '```json\n{"findings":[{"file":"src/a.ts","line":12,"title":"user missing causes null deref","severity_guess":"P1"}]}\n```';
const r3 = '```json\n[{"file":"src/a.ts","line":11,"title":"null deref on missing user","severity_guess":"P2"}]\n```\nnot json: ```json\n{broken\n```';

describe("interrogate ingest", () => {
  it("parses JSON finding blocks from arrays and {findings}", () => {
    expect(findingsOf(r1)).toHaveLength(2);
    expect(findingsOf(r2)).toHaveLength(1);
    expect(findingsOf(r3)).toHaveLength(1);
  });
  it("dedupes across lanes and classifies consensus / single / disputed", () => {
    const m = dedupe([{ label: "r1", findings: findingsOf(r1) }, { label: "r2", findings: findingsOf(r2) }]);
    expect(m).toHaveLength(2);
    expect(classifyAgreement(m[0]!)).toBe("consensus");
    expect(classifyAgreement(m[1]!)).toBe("single");
    const d = dedupe([{ label: "r1", findings: findingsOf(r1) }, { label: "r3", findings: findingsOf(r3) }]);
    expect(classifyAgreement(d[0]!)).toBe("disputed");
  });
  it("merges the same Chinese finding without merging a different issue at the same location", () => {
    const file = "src/main/jev/client.ts";
    const m = dedupe([
      { label: "r1", findings: [{ file, line: 119, title: "凭证错误消息可能失去填写指引" }] },
      { label: "r3", findings: [
        { file, line: 119, title: "中继路径假设 host 凭证消息自带填写指引，若消息匹配凭证正则但无指引则丢失去向提示" },
        { file, line: 119, title: "凭证错误消息可能泄露密钥" },
      ] },
    ]);
    expect(m).toHaveLength(2);
    expect(m[0]?.lanes).toEqual(["r1", "r3"]);
    expect(classifyAgreement(m[0]!)).toBe("consensus");
    expect(classifyAgreement(m[1]!)).toBe("single");
  });
  it("merges Chinese paraphrases of the same finding at the same line", () => {
    const cn1 = '```json\n[{"file":"src/main/jev/client.ts","line":119,"title":"凭证错误消息可能失去填写指引","severity_guess":"P1"}]\n```';
    const cn3 = '```json\n[{"file":"src/main/jev/client.ts","line":119,"title":"中继路径假设 host 凭证消息自带填写指引，若消息匹配凭证正则但无指引则丢失去向提示","severity_guess":"P1"}]\n```';
    const m = dedupe([{ label: "r1", findings: findingsOf(cn1) }, { label: "r3", findings: findingsOf(cn3) }]);
    expect(m).toHaveLength(1);
    expect(m[0]!.lanes).toEqual(["r1", "r3"]);
    expect(classifyAgreement(m[0]!)).toBe("consensus");
  });
  it("does not merge different Chinese issues at the same file and line", () => {
    const lostGuide = '```json\n[{"file":"src/main/jev/client.ts","line":119,"title":"凭证错误消息可能失去填写指引"}]\n```';
    const expiry = '```json\n[{"file":"src/main/jev/client.ts","line":119,"title":"host 未校验凭证过期时间导致请求失败"}]\n```';
    const m = dedupe([{ label: "r1", findings: findingsOf(lostGuide) }, { label: "r2", findings: findingsOf(expiry) }]);
    expect(m).toHaveLength(2);
    expect(m.map((row) => classifyAgreement(row))).toEqual(["single", "single"]);
  });
  it("does not merge Chinese titles that only share generic two-character words", () => {
    const a = '```json\n[{"file":"src/a.ts","line":10,"title":"错误消息可能丢失"}]\n```';
    const b = '```json\n[{"file":"src/a.ts","line":10,"title":"可能错误处理空值"}]\n```';
    const m = dedupe([{ label: "r1", findings: findingsOf(a) }, { label: "r2", findings: findingsOf(b) }]);
    expect(m).toHaveLength(2);
  });
});

describe("arena and swarm ingest", () => {
  it("reads the cross-judge JSON", () => {
    expect(crossJudge('```json\n{"base":"c2","graft":["tests from c1"],"reasons":["smallest"]}\n```')).toEqual({ base: "c2", graft: ["tests from c1"], reasons: ["smallest"] });
    expect(crossJudge("no json").base).toBeNull();
  });
  it("swarm: PASS needs a verdict, a SHA and a method; otherwise it is a gap", () => {
    expect(swarmRow("s1", "ran `npx vitest run` at 3f2a9c1\nVERDICT: PASS")).toMatchObject({ verdict: "PASS", sha: "3f2a9c1", gap: null });
    expect(swarmRow("s2", "looks fine\nVERDICT: PASS")).toMatchObject({ verdict: "PASS", gap: "缺 commit SHA、缺验证方法" });
    expect(swarmRow("s3", "stuck")).toMatchObject({ verdict: null });
  });
});

describe("fanout_ingest tool", () => {
  it("interrogate: batches J4 once and marks only P0/P1 as fix candidates", async () => {
    const h = fakeHost({ fetch: typesafeAnswering(0.9, (_id, q) => (q.criteria.P1 !== undefined ? "P1" : Object.keys(q.criteria)[0]!)) });
    await h.fs({ op: "write", root: "data", path: "fanout/fo-x.json", content: JSON.stringify({ fanout_id: "fo-x", kind: "interrogate", base_ref: null, repo_root: null, routing: {}, lanes: [], task: "t" }) });
    const r: any = await runTool(makeContext(h, "c"), "fanout_ingest", { fanout_id: "fo-x", kind: "interrogate", lane_results: [{ label: "r1", text: r1 }, { label: "r2", text: r2 }] });
    expect(r.ok).toBe(true);
    expect(h.fetches).toHaveLength(1);
    expect(r.result.findings.every((f: any) => f.fix_candidate)).toBe(true);
    expect(r.result.consensus).toBe(1);
  });
  it("swarm: reports missing lanes and gaps", async () => {
    const h = fakeHost();
    await h.fs({ op: "write", root: "data", path: "fanout/fo-y.json", content: JSON.stringify({ fanout_id: "fo-y", kind: "swarm", base_ref: null, repo_root: null, routing: {}, lanes: [{ label: "s1" }, { label: "verify" }], task: "t" }) });
    const r: any = await runTool(makeContext(h, "c"), "fanout_ingest", { fanout_id: "fo-y", lane_results: [{ label: "s1", text: "VERDICT: PASS" }] });
    expect(r.result).toMatchObject({ missing_lanes: ["verify"], all_pass: false });
  });
  it("unknown fanout id → FANOUT_NOT_FOUND", async () => {
    expect(await runTool(makeContext(fakeHost(), "c"), "fanout_ingest", { fanout_id: "nope", kind: "swarm" })).toMatchObject({ ok: false, errorCode: "FANOUT_NOT_FOUND" });
  });
});
