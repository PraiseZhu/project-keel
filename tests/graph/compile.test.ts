import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allGraphs, graphForTask, PSTACK_GRAPHS, TASK_TYPES } from "../../src/shared/graph/pstack.ts";
import {
  expectedStepsFor,
  parseNumberedSteps,
  validateGraph,
  type GraphSpec,
} from "../../src/shared/graph/spec.ts";

const PB_DIR = join("plugin/manual/pstack/skills/poteto-mode/playbooks");
const PLAYBOOK_IDS = ["bug-fix", "feature", "refactoring", "investigation", "opening-a-pr", "babysit", "shipping", "autonomous-run"] as const;

function loadPlaybooks(): Record<string, string> {
  return Object.fromEntries(PLAYBOOK_IDS.map((id) => [id, readFileSync(join(PB_DIR, `${id}.md`), "utf8")]));
}

const playbooks = loadPlaybooks();

function stepsOf(id: string): string[] {
  return parseNumberedSteps(id, playbooks[id]!);
}

function mappedOrAdapted(spec: GraphSpec, step: string): boolean {
  if (spec.nodes.some((n) => n.playbook_steps.includes(step))) return true;
  return spec.adaptations.some((a) => a.playbook_step === step);
}

describe("pstack graph compile", () => {
  it("every playbook step mapped", () => {
    for (const spec of allGraphs()) {
      const expected = expectedStepsFor(spec, playbooks);
      expect(expected.issues, spec.id).toEqual([]);
      const missing = expected.steps.filter((step) => !mappedOrAdapted(spec, step));
      expect(missing, `${spec.id} unmapped`).toEqual([]);
      expect(validateGraph(spec, expected.steps)).toEqual([]);
    }
    for (const id of PLAYBOOK_IDS) {
      const coveredBy = allGraphs().filter((g) => g.covers.includes(id));
      expect(coveredBy.length, `${id} has a graph`).toBeGreaterThan(0);
      const steps = stepsOf(id);
      for (const spec of coveredBy) {
        const missing = steps.filter((step) => !mappedOrAdapted(spec, step));
        expect(missing, `${spec.id} missing ${id}`).toEqual([]);
      }
    }
  });

  it("every loop has exit", () => {
    for (const spec of allGraphs()) {
      const issues = validateGraph(spec).filter((i) => i.rule === "loop_exit" || i.rule === "loop_max_attempts");
      expect(issues, spec.id).toEqual([]);
    }
  });

  it("investigation has no PR tail, writes, or architect", () => {
    const spec = graphForTask("investigation");
    expect(spec.covers).toEqual(["investigation"]);
    expect(spec.nodes.some((n) => n.writes)).toBe(false);
    expect(spec.nodes.some((n) => n.role === "architect")).toBe(false);
    expect(spec.nodes.map((n) => n.id)).not.toEqual(expect.arrayContaining(["open-pr", "wait-ci", "astra-final-review", "verify-head", "report-ready"]));
    expect(spec.nodes.some((n) => n.id === "report")).toBe(true);
    expect(spec.entry).toBe("explore");
    const report = spec.nodes.find((n) => n.id === "report")!;
    expect(spec.edges.some((e) => e.from === report.id && e.to === "done" && e.on === "ok")).toBe(true);
    expect(validateGraph(spec, expectedStepsFor(spec, playbooks).steps)).toEqual([]);
  });

  it("pr graph is tail only", () => {
    const spec = graphForTask("pr");
    expect(spec.entry).toBe("open-pr");
    expect(spec.covers).toEqual(["opening-a-pr", "babysit", "shipping", "autonomous-run"]);
    const ids = spec.nodes.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(["open-pr", "wait-ci", "ci-rerun-once", "astra-unstick", "astra-final-review", "verify-head", "report-ready", "done"]));
    expect(ids).not.toEqual(expect.arrayContaining(["reproduce", "implement", "architect-plan", "explore", "pin-test", "arena"]));
    expect(validateGraph(spec, expectedStepsFor(spec, playbooks).steps)).toEqual([]);
  });

  it("Astra three checkpoints exist with the right conditions", () => {
    const bug = graphForTask("bug-fix");
    const feature = graphForTask("feature");
    const refactoring = graphForTask("refactoring");
    const investigation = graphForTask("investigation");
    const pr = graphForTask("pr");

    expect(bug.nodes.find((n) => n.id === "architect-plan")?.when).toEqual({ kind: "crosses_function_boundary" });
    expect(feature.nodes.find((n) => n.id === "architect-plan")?.when).toEqual({ kind: "always" });
    expect(refactoring.nodes.find((n) => n.id === "architect-plan")?.when).toEqual({ kind: "crosses_function_boundary" });
    expect(investigation.nodes.some((n) => n.id === "architect-plan" || n.role === "architect")).toBe(false);

    for (const spec of [bug, feature, refactoring, pr]) {
      const unstick = spec.nodes.find((n) => n.id === "astra-unstick");
      expect(unstick?.role, spec.id).toBe("architect");
      expect(unstick?.when, spec.id).toEqual({ kind: "fingerprint_repeat", times: 2 });
      expect(spec.edges.some((e) => e.on === "fingerprint_repeat" && e.to === "astra-unstick"), spec.id).toBe(true);
      expect(spec.nodes.some((n) => n.id === "astra-final-review" && n.role === "architect"), spec.id).toBe(true);
    }
    expect(investigation.nodes.some((n) => n.id === "astra-unstick" || n.id === "astra-final-review")).toBe(false);
  });

  it("validateGraph names the graph and the broken rule", () => {
    const bad: GraphSpec = {
      id: "bad-fixture",
      version: 1,
      nodes: [
        { id: "start", kind: "tool", writes: false, playbook_steps: [], timebox_min: 1, max_attempts: 3 },
        { id: "island", kind: "tool", writes: false, playbook_steps: [], timebox_min: 1, max_attempts: 3 },
        { id: "loop-a", kind: "tool", writes: false, playbook_steps: [], timebox_min: 1, max_attempts: 3 },
        { id: "loop-b", kind: "tool", writes: false, playbook_steps: [], timebox_min: 1, max_attempts: 3 },
        { id: "done", kind: "tool", writes: false, playbook_steps: [], timebox_min: 1, max_attempts: 1 },
        { id: "stopped", kind: "tool", writes: false, playbook_steps: [], timebox_min: 1, max_attempts: 1 },
      ],
      edges: [
        { from: "start", to: "done", on: "ok" },
        { from: "loop-a", to: "loop-b", on: "ok" },
        { from: "loop-b", to: "loop-a", on: "ok" },
      ],
      entry: "start",
      exits: ["done", "stopped"],
      covers: ["bug-fix"],
      adaptations: [],
    };
    const issues = validateGraph(bad, ["bug-fix#1"]);
    expect(issues.some((i) => i.graph === "bad-fixture" && i.rule === "unreachable" && i.message.includes("island"))).toBe(true);
    expect(issues.some((i) => i.graph === "bad-fixture" && i.rule === "loop_exit" && /loop-a|loop-b/.test(i.message))).toBe(true);
    expect(issues.some((i) => i.graph === "bad-fixture" && i.rule === "unmapped_step" && i.message.includes("bug-fix#1"))).toBe(true);

    const writingInv: GraphSpec = {
      ...graphForTask("investigation"),
      id: "investigation",
      nodes: graphForTask("investigation").nodes.map((n) => (n.id === "report" ? { ...n, writes: true, role: "architect" as const } : n)),
    };
    const invIssues = validateGraph(writingInv);
    expect(invIssues.some((i) => i.rule === "investigation_writes" && i.message.includes("report"))).toBe(true);
    expect(invIssues.some((i) => i.rule === "investigation_architect" && i.message.includes("report"))).toBe(true);
  });

  it("compiled graphs are the five task types and pass structural validation", () => {
    expect(TASK_TYPES.slice().sort()).toEqual(["bug-fix", "feature", "investigation", "pr", "refactoring"]);
    expect(Object.keys(PSTACK_GRAPHS).sort()).toEqual([...TASK_TYPES].sort());
    for (const spec of allGraphs()) {
      expect(spec.version).toBe(1);
      expect(spec.exits).toEqual(["done", "stopped"]);
      expect(validateGraph(spec)).toEqual([]);
    }
  });
});
