import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { KeelProfile } from "../src/shared/types.ts";
import { makeContext } from "../src/main/context.ts";
import { runTool } from "../src/main/dispatch.ts";
import { writeHandoff } from "../src/main/handoff.ts";
import { installUpstreamRunner } from "../src/node/context.ts";
import { dispatch } from "../src/node/rpc.ts";
import { fakeHost } from "./helpers/fakeHost.ts";

const roots: string[] = [];
const repo = "example-org/example-plugin", head = "a".repeat(40);
const realHelper = process.env.VIGIL_HELPER_UNDER_TEST;
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "keel-vigil-")); roots.push(root);
  const file = join(root, "remote.json"), calls = join(root, "calls.jsonl");
  const state = {
    seq: 0, actor: "ExampleUser", failHandoff: false, failAfterWrite: false, driftOnReady: false, checksPassed: true,
    pr: { id: "PR_FIXTURE", repo, number: 7, title: "feat: fixture", url: `https://github.com/${repo}/pull/7`,
      state: "OPEN", isDraft: true, headRefOid: head, headRefName: "feature", baseRefOid: "b".repeat(40), baseRefName: "main",
      createdAt: "2026-09-01T00:00:00Z", author: { login: "ExampleUser" }, isCrossRepository: false, sameRepository: true,
      headRepository: { name: "example-plugin" }, headRepositoryOwner: { login: "example-org" }, labels: [],
      mergedAt: null, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null },
    events: [{ __typename: "ConvertToDraftEvent", id: "DRAFT_0", createdAt: "2026-09-02T00:00:00Z" }],
    comments: [] as any[],
  };
  writeFileSync(file, JSON.stringify(state)); writeFileSync(calls, "");
  // A real external Node executable on PATH, independent of the Host's execPath.
  writeFileSync(join(root, "node"), `#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process');\nfs.appendFileSync(process.env.KEEL_HANDOFF_TEST_CALLS,JSON.stringify(['external-node',...process.argv.slice(2)])+'\\n');\nconst r=cp.spawnSync(${JSON.stringify(process.execPath)},process.argv.slice(2),{stdio:'inherit'});process.exit(r.status??1);\n`, { mode: 0o700 });
  const gh = join(root, "gh");
  writeFileSync(gh, `#!${process.execPath}\n${remoteProgram}\n`, { mode: 0o700 });
  const stub = join(root, "helper.mjs");
  writeFileSync(stub, `import fs from 'node:fs';
const [mode,...args]=process.argv.slice(2),p=process.env.KEEL_HANDOFF_TEST_STATE,s=JSON.parse(fs.readFileSync(p));
fs.appendFileSync(process.env.KEEL_HANDOFF_TEST_CALLS,JSON.stringify(['helper',mode,...args])+'\\n');
const e=s.events.at(-1),epoch=(e.__typename==='ReadyForReviewEvent'?'ready':'draft')+':'+s.pr.id+':'+e.id+':'+e.createdAt;
const receipt=s.comments.map(c=>JSON.parse(c.body.match(/vigil-handoff (.*) -->/)[1])).find(r=>r.releaseEpoch===epoch)||null;
if(mode==='inspect') console.log(JSON.stringify({status:s.pr.isDraft?'author-owned':receipt?'handed-off':'ready-unclaimed',pr:{...s.pr,releaseEpoch:epoch},receipt:s.pr.isDraft?null:receipt,authorAuthorized:s.actor===s.pr.author.login}));
else if(mode==='handoff'){
 if(s.failHandoff || s.pr.isDraft || args[args.indexOf('--expected-head')+1]!==s.pr.headRefOid)process.exit(2);
 const r=receipt||{version:1,id:String(100+s.comments.length),repo:s.pr.repo,number:s.pr.number,nodeId:s.pr.id,head:s.pr.headRefOid,releaseEpoch:epoch,author:s.pr.author.login};
 if(!receipt)s.comments.push({id:r.id,body:'<!-- vigil-handoff '+JSON.stringify(r)+' -->'});
 fs.writeFileSync(p,JSON.stringify(s));if(s.failAfterWrite)process.exit(2);console.log(JSON.stringify({status:receipt?'already-handed-off':'handed-off',receipt:r}));
}else process.exit(2);`);
  vi.stubEnv("PATH", `${root}${delimiter}${process.env.PATH ?? ""}`);
  vi.stubEnv("GH_BIN", gh); vi.stubEnv("MIVO_WATCHER_TARGET_REPO", repo);
  vi.stubEnv("MIVO_WATCHER_HOME", root); vi.stubEnv("MIVO_WATCHER_PROFILE", "");
  vi.stubEnv("KEEL_HANDOFF_TEST_STATE", file); vi.stubEnv("KEEL_HANDOFF_TEST_CALLS", calls);
  installUpstreamRunner();
  const profile: KeelProfile = { lanes: [{ repo, preset: "draft-gated-handoff", handoffHelperPath: realHelper || stub }], routingPath: null, plansDir: null, boardRepos: [] };
  const host = fakeHost({ node: async (method, params) => {
    const result = await dispatch(method, params);
    return result.error ? { ok: false, message: result.error.message } : { ok: true, result: result.result };
  } });
  const ctx = makeContext(host, "fixture", profile);
  const read = () => JSON.parse(readFileSync(file, "utf8")) as typeof state;
  const update = (fn: (s: typeof state) => void) => { const value = read(); fn(value); writeFileSync(file, JSON.stringify(value)); };
  const ready = (dry = false) => runTool(ctx, "pr_ready", { repo, pr: 7, dry_run: dry,
    authorization_source: "User authorized handoff of this fixture PR",
    review_entry: { head_sha: head, checked_at: new Date(host.now()).toISOString(), result: "pass", source: "isolated review-entry fixture" } });
  return { host, ctx, ready, read, update,
    calls: () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)),
    localRecords: () => [...host.files.keys()].filter(k => k.startsWith("handoff/")),
  };
}

const remoteProgram = `
const fs=require('node:fs'),args=process.argv.slice(2),file=process.env.KEEL_HANDOFF_TEST_STATE;
if(args[0]==='--version'){console.log('gh version fixture');process.exit(0);}
const s=JSON.parse(fs.readFileSync(file));
fs.appendFileSync(process.env.KEEL_HANDOFF_TEST_CALLS,JSON.stringify(args)+'\\n');
const send=v=>process.stdout.write(JSON.stringify(v)),page=nodes=>({nodes,pageInfo:{hasNextPage:false,endCursor:null}});
if(args[0]==='pr'&&args[1]==='view')send(s.pr);
else if(args[0]==='pr'&&args[1]==='checks')send([{name:'unit',state:s.checksPassed?'SUCCESS':'FAILURE',bucket:s.checksPassed?'pass':'fail',description:'fixture',link:'https://example.invalid/check',workflow:'test'}]);
else if(args[0]==='pr'&&args[1]==='ready'){
 s.seq++;s.pr.isDraft=args.includes('--undo');
 s.events.push({__typename:s.pr.isDraft?'ConvertToDraftEvent':'ReadyForReviewEvent',id:(s.pr.isDraft?'DRAFT_':'READY_')+s.seq,createdAt:new Date(Date.UTC(2026,8,2,0,0,s.seq)).toISOString()});
 if(s.driftOnReady)s.pr.headRefOid='c'.repeat(40);fs.writeFileSync(file,JSON.stringify(s));
}else if(args[0]==='api'&&args[1]==='user')send({login:s.actor,type:'User'});
else if(args[1]==='graphql'){
 const q=args.find(a=>a.startsWith('query='))||'';
 if(q.includes('timelineItems'))send({data:{node:{timelineItems:page(s.events)}}});
 else send({data:{repository:{pullRequest:{reviewThreads:page([]),commits:page([])}}}});
}else if(args[1]?.includes('/issues/7/comments')){
 if(args.includes('POST')){
  if(s.failHandoff)process.exit(2);
  const body=args[args.indexOf('-f')+1].slice(5),r={id:100+s.comments.length,body,user:{login:s.actor,type:'User'},created_at:new Date(Date.UTC(2026,8,2,0,0,s.seq+1)).toISOString()};
  s.comments.push(r);fs.writeFileSync(file,JSON.stringify(s));if(s.failAfterWrite)process.exit(2);send(r);
 }else send([s.comments]);
}else {process.stderr.write('unexpected fake gh request '+JSON.stringify(args));process.exit(2);}
`;

describe("configured Vigil author handoff through the real Keel tool/RPC path", { timeout: 20_000 }, () => {
  it("marks Ready, automatically obtains the external receipt, then stops author writes", async () => {
    const f = fixture();
    const r = await f.ready();
    expect(r).toMatchObject({ ok: true, result: { ready: true, handed_off: true, handoff: { watcher_receipt: { head } } } });
    expect(f.read().pr.isDraft).toBe(false); expect(f.read().comments).toHaveLength(1);
    expect(f.localRecords()).toHaveLength(1);
    expect(f.calls().some(a => a[0] === "external-node" && a.includes("inspect"))).toBe(true);
    expect(f.calls().some(a => a[0] === "external-node" && a.includes("handoff"))).toBe(true);
    expect(await f.ready()).toMatchObject({ ok: false, errorCode: "LANE_HANDED_OFF" });
    expect(f.read().comments).toHaveLength(1);
    expect(await runTool(f.ctx, "pr_status", { repo, pr: 7 })).toMatchObject({ ok: true, result: { handedOff: true, nextAction: "stopped_after_handoff" } });
  });

  it("dry-run never marks Ready or emits a receipt", async () => {
    const f = fixture(); await f.ready(true);
    expect(f.read().pr.isDraft).toBe(true); expect(f.read().comments).toHaveLength(0); expect(f.localRecords()).toHaveLength(0);
    expect(f.calls().some(a => a[1] === "ready" || a.includes("POST") || (a[0] === "helper" && a[1] === "handoff"))).toBe(false);
  });

  it("a helper failure after Ready cannot claim a completed handoff", async () => {
    const f = fixture(); f.update(s => { s.failHandoff = true; });
    expect(await f.ready()).toMatchObject({ ok: false, errorCode: "HANDOFF_HELPER_FAILED" });
    expect(f.read().comments).toHaveLength(0); expect(f.localRecords()).toHaveLength(0);
    f.update(s => { s.failHandoff = false; });
    expect(await f.ready()).toMatchObject({ ok: true, result: { handed_off: true } });
  });

  it("HEAD drift after Ready is rejected before receipt publication", async () => {
    const f = fixture(); f.update(s => { s.driftOnReady = true; });
    expect(await f.ready()).toMatchObject({ ok: false, errorCode: "HANDOFF_HELPER_FAILED" });
    expect(f.read().comments).toHaveLength(0); expect(f.localRecords()).toHaveLength(0);
  });

  it("another GitHub account cannot mark Ready for automatic handoff", async () => {
    const f = fixture(); f.update(s => { s.actor = "OtherUser"; });
    expect(await f.ready()).toMatchObject({ ok: false, errorCode: "HANDOFF_AUTHOR_REQUIRED" });
    expect(f.read().pr.isDraft).toBe(true); expect(f.read().comments).toHaveLength(0);
  });

  it("Draft and a missed same-head Ready cycle do not inherit an obsolete local record", async () => {
    const f = fixture(); await f.ready();
    f.update(s => { s.seq++; s.pr.isDraft = true; s.events.push({ __typename: "ConvertToDraftEvent", id: "DRAFT_NEXT", createdAt: "2026-09-03T00:00:00Z" }); });
    expect(await runTool(f.ctx, "pr_status", { repo, pr: 7 })).toMatchObject({ ok: true, result: { handedOff: false } });
    f.update(s => { s.seq++; s.pr.isDraft = false; s.events.push({ __typename: "ReadyForReviewEvent", id: "READY_NEXT", createdAt: "2026-09-03T00:00:01Z" }); });
    // Re-use a well-formed current gate, with no inspection required during Draft.
    if (realHelper) f.update(s => { s.seq = 86410; });
    expect(await f.ready()).toMatchObject({ ok: true, result: { handed_off: true } });
    expect(f.read().comments).toHaveLength(2);
  });

  it("an existing external handoff is authoritative when the local record is missing", async () => {
    const f = fixture(); await f.ready();
    f.host.files.clear();
    expect(await f.ready()).toMatchObject({ ok: false, errorCode: "LANE_HANDED_OFF" });
    expect(f.read().comments).toHaveLength(1);
  });

  it("old local records without a current external receipt cannot lock a reclaimed author", async () => {
    const f = fixture();
    await writeHandoff(f.host, { repo, number: 7, at: "old", head_sha: head, gate: {}, evidence: {} });
    expect(await f.ready()).toMatchObject({ ok: true, result: { handed_off: true } });
    expect(f.read().comments).toHaveLength(1);
  });

  it("a lost publication response is recovered from the external receipt without a second write", async () => {
    const f = fixture(); f.update(s => { s.failAfterWrite = true; });
    expect(await f.ready()).toMatchObject({ ok: false, errorCode: "HANDOFF_HELPER_FAILED" });
    expect(f.read().comments).toHaveLength(1); expect(f.localRecords()).toHaveLength(0);
    f.update(s => { s.failAfterWrite = false; });
    expect(await f.ready()).toMatchObject({ ok: false, errorCode: "LANE_HANDED_OFF" });
    expect(f.read().comments).toHaveLength(1);
    expect(await runTool(f.ctx, "pr_status", { repo, pr: 7 })).toMatchObject({ ok: true, result: { handedOff: true } });
  });

  it("the configured helper cannot bypass the original CI gate", async () => {
    const f = fixture(); f.update(s => { s.checksPassed = false; });
    expect(await f.ready()).toMatchObject({ ok: false, errorCode: "GATE_NOT_MET" });
    expect(f.read().pr.isDraft).toBe(true); expect(f.read().comments).toHaveLength(0);
  });

  it("kv.lanes helper path is used when packed profile lanes are empty, and status is stopped_after_handoff", async () => {
    const f = fixture();
    const helperPath = f.ctx.profile.lanes[0]?.handoffHelperPath;
    expect(helperPath).toBeTruthy();
    f.host.kv.lanes = [{ repo, preset: "draft-gated-handoff", handoffHelperPath: helperPath }];
    const ctx = makeContext(f.host, "kv-lanes", { lanes: [], routingPath: null, plansDir: null, boardRepos: [] });
    const ready = () => runTool(ctx, "pr_ready", {
      repo, pr: 7,
      authorization_source: "User authorized handoff of this fixture PR",
      review_entry: { head_sha: head, checked_at: new Date(f.host.now()).toISOString(), result: "pass", source: "isolated review-entry fixture" },
    });
    expect(await ready()).toMatchObject({ ok: true, result: { handed_off: true, handoff: { watcher_receipt: { head } } } });
    expect(await runTool(ctx, "pr_status", { repo, pr: 7 })).toMatchObject({
      ok: true,
      result: { handedOff: true, nextAction: "stopped_after_handoff" },
    });
    expect(f.read().comments).toHaveLength(1);
  });
});
