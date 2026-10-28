import { describe, expect, it } from "vitest";
import { makeContext } from "../../src/main/context.ts";
import { runTool } from "../../src/main/dispatch.ts";
import { advance, createRun } from "../../src/main/graph/interpreter.ts";
import { sameRoute } from "../../src/main/graph/collaboration.ts";
import { findModel } from "../../src/panel/manual-editor.ts";
import { PSTACK_GRAPHS } from "../../src/shared/graph/pstack.ts";
import { cloneManual, DEFAULT_MANUAL, type AgentModel, type Profile, type Route } from "../../src/shared/manual/schema.ts";
import { validateManual } from "../../src/shared/manual/validate.ts";
import { EMPTY_PROFILE } from "../../src/shared/types.ts";
import { boot, readState } from "./helpers.ts";
import { fakeHost } from "../helpers/fakeHost.ts";

const DEVICE = "device-claude-aaaaaaaa";
const remotePrimary: Route = { agent: "codex", model: "gpt-6.1-sol", provider_id: "art-cindy", effort: "high", agent_device_id: DEVICE };
const localSame: Route = { agent: "codex", model: "gpt-6.1-sol", provider_id: "art-cindy", effort: "high" };
const localFallback: Route = { agent: "codex", model: "openai/gpt-6.1-sol", provider_id: "xd", effort: "high" };

function withWorker(primary: Route, fallback?: Route) {
  const manual = cloneManual(DEFAULT_MANUAL);
  const sol = manual.profiles.find((p) => p.id === "sol")!;
  (sol as { nodes: Profile["nodes"] }).nodes = {
    default: {
      ...sol.nodes.default,
      worker: { primary, ...(fallback ? { fallbacks: [fallback] } : { fallbacks: [] }) },
    },
  };
  return manual;
}

function model(partial: AgentModel): AgentModel {
  return { visible: true, efforts: ["low", "medium", "high", "xhigh", "max"], ...partial };
}

const localModels: AgentModel[] = [
  model({ id: "gpt-6.1-sol", agent: "codex", providerId: "art-cindy" }),
  model({ id: "openai/gpt-6.1-sol", agent: "codex", providerId: "xd" }),
  model({ id: "gpt-6-astra", agent: "codex", providerId: "art-cindy" }),
  model({ id: "anthropic/claude-opus-5-5", agent: "claude-code", providerId: "xd" }),
  model({ id: "anthropic/claude-sonnet-5-5", agent: "claude-code", providerId: "xd" }),
];

const remoteModels: AgentModel[] = [
  ...localModels,
  model({ id: "gpt-6.1-sol", agent: "codex", providerId: "art-cindy", agentDeviceId: DEVICE, deviceName: "Claude" }),
];

const unread = [{ agentDeviceId: DEVICE, name: "Claude" }];

async function dispatch(manual: ReturnType<typeof withWorker>, models: AgentModel[], unreadDevices?: typeof unread) {
  const h = fakeHost({
    kv: { manual },
    agentModels: models,
    node: (method: string) => {
      if (method === "git/state") return { ok: true, result: { root: "/repo", branch: "feat/x", head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } };
      return { ok: false, message: method };
    },
  });
  const { spec } = await boot({ worktree: "/repo/.worktrees/keel-run1" }, h);
  const opts = { spec, models, ...(unreadDevices ? { unreadDevices } : {}) };
  await advance(h, "run1", { type: "tick" }, opts);
  const out = await advance(h, "run1", {
    type: "report", phase: "setup",
    outcome: { worker_permission_mode: "bypassPermissions", team_id: "team-1" },
    session_id: "sol-1",
  }, opts);
  return { h, spec, opts, out };
}

describe("planOrca remote device", () => {
  it("copies the selected route device into planned_params and create_worker", async () => {
    const { h, out } = await dispatch(withWorker(remotePrimary, localFallback), remoteModels);
    expect(out.next.kind).toBe("dispatch");
    if (out.next.kind !== "dispatch") throw new Error("dispatch");
    expect(out.next.create_worker?.agent_device_id).toBe(DEVICE);
    expect(readState(h).nodes.worker?.planned_params?.agent_device_id).toBe(DEVICE);
  });

  it("replays the same remote device from planned_params", async () => {
    const { h, opts, out } = await dispatch(withWorker(remotePrimary), remoteModels);
    if (out.next.kind !== "dispatch") throw new Error("dispatch");
    const again = await advance(h, "run1", { type: "tick" }, opts);
    expect(again.next.kind).toBe("dispatch");
    if (again.next.kind !== "dispatch") throw new Error("dispatch");
    expect(again.next.create_worker?.agent_device_id).toBe(DEVICE);
    expect(again.next.dispatch_key).toBe(out.next.dispatch_key);
  });
});

describe("pickRoute remote catalog unread", () => {
  it("falls back to the next configured route and names the computer", async () => {
    const { out } = await dispatch(withWorker(remotePrimary, localFallback), localModels, unread);
    expect(out.next.kind).toBe("dispatch");
    if (out.next.kind !== "dispatch") throw new Error("dispatch");
    expect(out.next.create_worker?.agent_device_id).toBe("local");
    expect(out.next.create_worker?.model).toBe("openai/gpt-6.1-sol");
    expect(out.next.note).toMatch(/Claude 的清单读不到/);
  });

  it("stops with the computer name when there is no fallback", async () => {
    const { out } = await dispatch(withWorker(remotePrimary), localModels, unread);
    expect(out.next.kind).toBe("stop");
    if (out.next.kind !== "stop") throw new Error("stop");
    expect(out.next.reason).toMatch(/Claude 的清单读不到/);
  });

  it("does not use a local same-name model that is not on the fallback chain", async () => {
    const { out } = await dispatch(withWorker(remotePrimary), localModels, unread);
    expect(out.next.kind).toBe("stop");
    if (out.next.kind !== "stop") throw new Error("stop");
    expect(out.next.reason).toMatch(/Claude/);
    expect(JSON.stringify(out.next)).not.toMatch(/create_worker/);
  });
});

describe("route identity includes device", () => {
  const remoteOpus: Route = { agent: "claude-code", model: "anthropic/claude-opus-5-5", provider_id: "xd", effort: "xhigh", agent_device_id: DEVICE };
  const localOpus: Route = { agent: "claude-code", model: "anthropic/claude-opus-5-5", provider_id: "xd", effort: "xhigh" };
  const catalog: AgentModel[] = [
    ...localModels,
    model({ id: "anthropic/claude-opus-5-5", name: "Opus 5.5", agent: "claude-code", providerId: "xd", agentDeviceId: DEVICE, deviceName: "Claude" }),
  ];

  it("findModel does not treat a remote entry as the local one", () => {
    expect(findModel(catalog, localOpus.agent, localOpus.model, localOpus.provider_id)?.agentDeviceId).toBeUndefined();
    expect(findModel(catalog, remoteOpus.agent, remoteOpus.model, remoteOpus.provider_id, DEVICE)?.agentDeviceId).toBe(DEVICE);
    expect(findModel(catalog, remoteOpus.agent, remoteOpus.model, remoteOpus.provider_id, DEVICE)).not.toBe(
      findModel(catalog, localOpus.agent, localOpus.model, localOpus.provider_id),
    );
  });

  it("sameRoute distinguishes the same model on two computers", () => {
    expect(sameRoute(localOpus, { ...localOpus, agent_device_id: "local" })).toBe(true);
    expect(sameRoute(localOpus, remoteOpus)).toBe(false);
  });

  it("manual validation only accepts the matching device", () => {
    const remoteManual = withWorker(remoteOpus);
    expect(validateManual(remoteManual, localModels, { manual: remoteManual }).some((issue) => issue.message.includes("不存在"))).toBe(true);
    expect(validateManual(remoteManual, catalog, { manual: remoteManual }).some((issue) => issue.path.includes("worker") && issue.message.includes("不存在"))).toBe(false);
    const localManual = withWorker(localOpus);
    expect(validateManual(localManual, catalog, { manual: localManual }).some((issue) => issue.path.includes("worker") && issue.message.includes("不存在"))).toBe(false);
  });

  it("modelsAllow rejects a remote route when only the local twin is listed", async () => {
    const { out } = await dispatch(withWorker(remotePrimary), localModels);
    expect(out.next.kind).toBe("stop");
    if (out.next.kind !== "stop") throw new Error("stop");
    expect(out.next.reason).toMatch(/全部路线不可用/);
  });
});

describe("accepted receipt on a remote route", () => {
  async function dispatchRemote(runId: string) {
    const h = fakeHost({ kv: { manual: withWorker(remotePrimary) }, agentModels: remoteModels });
    const spec = PSTACK_GRAPHS["bug-fix"];
    await createRun(h, {
      run_id: runId,
      spec_id: spec.id,
      profile_id: "sol",
      lead_harness: "codex",
      task_type: "bug-fix",
      entry: "implement",
      goal: "fix the bug",
      worktree: "/repo/.worktrees/keel-run1",
      scopeAllow: ["src/**"],
      now: h.now(),
    });
    const d = await advance(h, runId, {
      type: "report",
      phase: "setup",
      outcome: { worker_permission_mode: "bypassPermissions", team_id: "t1" },
      session_id: "s1",
    }, { spec });
    return { h, d };
  }

  async function accept(h: Awaited<ReturnType<typeof dispatchRemote>>["h"], runId: string, dispatchKey: string, resolved: Record<string, unknown>) {
    return runTool(makeContext(h, `acc-${runId}`, EMPTY_PROFILE), "keel_report", {
      run_id: runId,
      phase: "accepted",
      dispatch_key: dispatchKey,
      worker_id: "w1",
      worker_session_id: "ws1",
      dispatch_outcome: { dispatched: true, wakeKind: "immediate" },
      resolved,
    });
  }

  const resolvedWithoutDevice = { agent: "codex", model: "gpt-6.1-sol", providerId: "art-cindy", effort: "high" };

  it("does not mismatch or record the worker as local when the receipt omits agent_device_id", async () => {
    const runId = "run-remote-omit-device";
    const { h, d } = await dispatchRemote(runId);
    expect(d.next.kind).toBe("dispatch");
    if (d.next.kind !== "dispatch") throw new Error("dispatch");
    expect(d.next.create_worker?.agent_device_id).toBe(DEVICE);
    const out = await accept(h, runId, d.next.dispatch_key, resolvedWithoutDevice);
    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (!out.ok) throw new Error(out.errorCode);
    expect(out.result).toMatchObject({ next: { kind: "wait" } });
    const node = readState(h, runId).nodes.implement;
    expect(node?.planned_params?.agent_device_id).toBe(DEVICE);
    expect(node?.actual_route).toEqual({
      agent: "codex",
      model: "gpt-6.1-sol",
      provider_id: "art-cindy",
      effort: "high",
    });
    expect(node?.actual_route?.agent_device_id).toBeUndefined();
  });

  it("keeps a receipt that names the planned remote device", async () => {
    const runId = "run-remote-matching-device";
    const { h, d } = await dispatchRemote(runId);
    if (d.next.kind !== "dispatch") throw new Error("dispatch");
    const out = await accept(h, runId, d.next.dispatch_key, { ...resolvedWithoutDevice, agent_device_id: DEVICE });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(readState(h, runId).nodes.implement?.actual_route).toEqual({
      agent: "codex",
      model: "gpt-6.1-sol",
      provider_id: "art-cindy",
      effort: "high",
      agent_device_id: DEVICE,
    });
  });

  it("rejects an accepted receipt whose agent_device_id is present and not the planned device", async () => {
    for (const [runId, device] of [
      ["run-remote-local-device", "local"],
      ["run-remote-other-device", "device-other-bbbbbbbb"],
    ] as const) {
      const { h, d } = await dispatchRemote(runId);
      if (d.next.kind !== "dispatch") throw new Error("dispatch");
      const out = await accept(h, runId, d.next.dispatch_key, { ...resolvedWithoutDevice, agent_device_id: device });
      expect(out.ok, JSON.stringify(out)).toBe(false);
      if (out.ok) throw new Error("expected mismatch");
      expect(out.errorCode).toBe("EXECUTION_ROUTE_MISMATCH");
    }
  });
});
