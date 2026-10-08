import { afterEach, describe, expect, it } from "vitest";
import { makeWorld, makeE2eHost, startRun, leadLoop, cleanupRepos, SC, PR_REPO, PR_NUMBER } from "../e2e/helpers.ts";
import { LANE_PRESETS, type VigilReceipt } from "../../src/shared/types.ts";

afterEach(cleanupRepos);

describe("kv.lanes Vigil helper through the graph handoff chain", () => {
  it("with helper in kv.lanes, Ready publishes a receipt and the run can done on stopped_after_handoff", async () => {
    const world = makeWorld();
    const host = makeE2eHost(world);
    const helper = "/abs/vigil-helper.mjs";
    host.kv.lanes = [{ repo: PR_REPO, preset: "gated-handoff", handoffHelperPath: helper }];
    let handed = false;
    let inspects = 0;
    const receipt = (): VigilReceipt => ({
      version: 1,
      id: "r1",
      repo: PR_REPO,
      number: PR_NUMBER,
      nodeId: "PR_FIXTURE",
      head: world.prHead,
      releaseEpoch: "ready:1",
      author: "tester",
    });
    const original = host.node.bind(host);
    host.node = async (method, params, opts) => {
      if (method === "pr/handoff-state") {
        inspects += 1;
        return handed
          ? {
            ok: true as const,
            result: {
              status: "handed-off",
              receipt: receipt(),
              authorAuthorized: true,
              pr: { headRefOid: world.prHead, state: "OPEN", isDraft: false, id: "PR_FIXTURE", repo: PR_REPO, number: PR_NUMBER, sameRepository: true, releaseEpoch: "ready:1", author: { login: "tester" } },
            },
          }
          : {
            ok: true as const,
            result: {
              status: "author-owned",
              receipt: null,
              authorAuthorized: true,
              pr: { headRefOid: world.prHead, state: "OPEN", isDraft: true, id: "PR_FIXTURE", repo: PR_REPO, number: PR_NUMBER, sameRepository: true, releaseEpoch: "draft:1", author: { login: "tester" } },
            },
          };
      }
      const response = await original(method, params, opts);
      if (method === "pr/snapshot" && response.ok) {
        return {
          ok: true as const,
          result: {
            ...(response.result as object),
            preset: "gated-handoff",
            rule: LANE_PRESETS["gated-handoff"],
            gate: { applies: true, required: ["verify"], passed: ["verify"], failing: [], pending: [], missing: [], ok: true, sources: ["test"] },
            pr: { ...(response.result as { pr: object }).pr, isDraft: !handed, headSha: world.prHead, state: "OPEN" },
          },
        };
      }
      if (method === "pr/ready" && response.ok) {
        handed = true;
        return { ok: true as const, result: { ...(response.result as object), watcher_handoff: receipt(), head_sha: world.prHead, ready: true, executed: true, gate: { passed: true, missing: [], required: ["verify"], sources: ["test"] } } };
      }
      return response;
    };
    const started = await startRun(host, { goal: "修登录报错", repo_dir: world.repoDir, lead: "codex", playbook: "bug-fix", scope: ["src/**"], sc: [...SC] });
    const finished = await leadLoop(host, started, world);
    expect(finished.next.kind).toBe("done");
    expect(finished.state.status).toBe("done");
    expect(host.nodeCalls.some((x) => x.method === "pr/ready")).toBe(true);
    expect(inspects).toBeGreaterThan(0);
    const lanes = host.nodeCalls.filter((c) => c.method === "pr/snapshot" || c.method === "pr/ready").map((c) => (c.params as { profile?: { lanes?: { handoffHelperPath?: string }[] } }).profile?.lanes);
    expect(lanes.some((ls) => ls?.some((l) => l.handoffHelperPath === helper))).toBe(true);
  });
});
