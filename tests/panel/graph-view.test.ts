import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadGraphStates } from "../../src/main/graph-snapshot.ts";
import {
  applyGraphMessage,
  EMPTY_GRAPH_MESSAGE,
  emptyStore,
  toRunView,
  viewFromStates,
  type GraphState,
} from "../../src/panel/graph-model.ts";
import { fakeHost } from "../helpers/fakeHost.ts";

const sample: GraphState = {
  run_id: "run-1",
  status: "waiting_human",
  goal: "修登录",
  repo: "acme/app",
  pr_binding: { repo: "acme/app", number: 7, branch: "fix", head_sha: "abc" },
  updated_at: "2026-10-07T00:00:00.000Z",
  next: { kind: "decide" },
  nodes: {
    implement: {
      status: "running",
      dispatch_state: "running",
      worker_label: "keel-impl-aaa",
      actual_route: { model: "grok-4.6", effort: "high", agent: "pi" },
    },
    verify: { status: "planned", dispatch_state: "planned" },
    done: { status: "terminal", dispatch_state: "terminal", ended_at: "2026-10-07T00:01:00.000Z" },
  },
  jev: [{ gate: "G-advance", choice: "advance", confidence: 0.82, routed: "act", at: "2026-10-07T00:00:10.000Z" }],
  sol_decisions: [{ gate: "G-route", answer: "bug-fix", at: "2026-10-07T00:00:05.000Z" }],
  astra_calls: 1,
  budget: { astra_left: 3 },
  verdict: { head_matches: false },
  human_inputs: 1,
};

describe("view model", () => {
  it("maps node status, in-flight workers, Jev, Astra, human gates, and GitHub", () => {
    const v = toRunView(sample, Date.parse("2026-10-07T00:10:00.000Z"));
    expect(v.run_id).toBe("run-1");
    expect(v.current_nodes).toEqual(["implement", "verify"]);
    expect(v.workers).toEqual([{ label: "keel-impl-aaa", model: "grok-4.6", effort: "high", dispatch_state: "running" }]);
    expect(v.jev[0]).toMatchObject({ gate: "G-advance", choice: "advance", confidence: "0.82", routed: "act" });
    expect(v.sol_decisions[0]?.answer).toBe("bug-fix");
    expect(v.astra).toEqual({ calls: 1, left: "3", last: "—" });
    expect(v.human_gates.join(" ")).toMatch(/人工|方向门/);
    expect(v.github.label).toBe("acme/app#7");
    expect(v.github.url).toBe("https://github.com/acme/app/pull/7");
    expect(v.elapsed).toBe("10m");
  });

  it("empty state when there are no runs", () => {
    const v = viewFromStates([]);
    expect(v.empty).toBe(true);
    expect(v.empty_message).toBe(EMPTY_GRAPH_MESSAGE);
    expect(v.runs).toEqual([]);
  });
});

describe("restore and incremental merge", () => {
  it("restore replaces the store; delta updates one run", () => {
    const first = applyGraphMessage(emptyStore(), { type: "graph", runs: [sample] });
    expect(Object.keys(first.runs)).toEqual(["run-1"]);
    const second = applyGraphMessage(first, {
      type: "graph-delta",
      run: { ...sample, run_id: "run-1", status: "running", nodes: { implement: { dispatch_state: "reported", status: "reported" } } },
    });
    expect(second.runs["run-1"]?.status).toBe("running");
    expect(second.runs["run-1"]?.nodes?.implement?.dispatch_state).toBe("reported");
    const extra = applyGraphMessage(second, { type: "graph", runs: [sample, { run_id: "run-2", status: "done", goal: "b" }] });
    expect(Object.keys(extra.runs).sort()).toEqual(["run-1", "run-2"]);
  });
});

describe("brain handler reads graph-state.json via host.fs", () => {
  it("lists runs/*/graph-state.json and skips junk", async () => {
    const h = fakeHost();
    h.files.set("runs/run-1/graph-state.json", JSON.stringify(sample));
    h.files.set("runs/run-2/graph-state.json", JSON.stringify({ run_id: "run-2", status: "done", goal: "x" }));
    h.files.set("runs/run-2/notes.txt", "ignore");
    h.files.set("runs/broken/graph-state.json", "{");
    const runs = await loadGraphStates(h);
    expect(runs.map((r) => r.run_id).sort()).toEqual(["run-1", "run-2"]);
  });
});

describe("manifest and build wiring", () => {
  it("ghost.json declares mainView pointing at a real HTML file with an external script", () => {
    const ghost = JSON.parse(readFileSync("plugin/ghost.json", "utf8")) as { mainView?: { title?: string; icon?: string; html?: string } };
    expect(ghost.mainView).toMatchObject({ title: "KEEL", icon: "chart-column", html: "graph-view.html" });
    expect(existsSync("plugin/graph-view.html")).toBe(true);
    const html = readFileSync("plugin/graph-view.html", "utf8");
    expect(html).toContain('src="graph-view.js"');
    expect(html).not.toMatch(/<script>(?!\s*<\/script>)/);
  });

  it("build.mjs emits plugin/graph-view.js from src/panel/graph-view.ts", () => {
    const build = readFileSync("scripts/build.mjs", "utf8");
    expect(build).toContain("src/panel/graph-view.ts");
    expect(build).toContain("plugin/graph-view.js");
    if (existsSync("plugin/graph-view.js")) {
      expect(readFileSync("plugin/graph-view.js", "utf8").length).toBeGreaterThan(100);
    }
  });
});
