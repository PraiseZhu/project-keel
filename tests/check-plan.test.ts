import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkPlan } from "../src/node/plan/check-plan.ts";
import { dispatch } from "../src/node/rpc.ts";
import "../src/node/extensions.ts";

describe("check-plan port", () => {
  it("keeps upstream rules verbatim", () => {
    const src = readFileSync("src/node/plan/check-plan.ts", "utf8");
    for (const s of ["Tests alone are not sufficient verification.", '"Verify, unit."', '"Review gate."', "mid-sentence colon", "long dash", "curly quote"]) expect(src).toContain(s);
  });
  it("flags typography and missing structure", () => {
    const r = checkPlan("# Plan\n\nA line with a dash — here and “quotes”.\n", "p.md");
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.includes("long dash"))).toBe(true);
    expect(r.problems.some((p) => p.includes("curly quote"))).toBe(true);
    expect(r.problems.some((p) => p.includes("no PR sections"))).toBe(true);
  });
  it("ignores fenced code", () => {
    const r = checkPlan("```\nx — y\n```\n", "p.md");
    expect(r.problems.some((p) => p.includes("long dash"))).toBe(false);
  });
  it("accepts a Cindy scheduler heartbeat in place of Cursor's /loop 1h", () => {
    const loop = (body: string) => checkPlan(`# P\n\n## Program checklist\n\n${body}\n`, "p.md").problems.some((p) => p.includes('lacks "/loop 1h"'));
    expect(loop("nothing here")).toBe(true);
    expect(loop("arm `/loop 1h`")).toBe(false);
    expect(loop("arm a schedule_create heartbeat")).toBe(false);
  });
  it.skipIf(!existsSync("plugin/node/check-plan.mjs"))("ships as an agent-run CLI with upstream exit codes", () => {
    const run = (args: string[]) => spawnSync(process.execPath, ["plugin/node/check-plan.mjs", ...args], { encoding: "utf8" });
    expect(run([]).status).toBe(2);
    mkdirSync("_tmp/test-runs", { recursive: true });
    writeFileSync("_tmp/test-runs/plan-cli.md", "# x\n");
    expect(run(["_tmp/test-runs/plan-cli.md"]).status).toBe(1);
  });
  it.skipIf(!existsSync("plugin/node/orch.mjs"))("orch ships as an agent-run CLI", () => {
    const r = spawnSync(process.execPath, ["plugin/node/orch.mjs", "--help"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("inbox");
  });
  it("is served over RPC as plan/check", async () => {
    const out: any = await dispatch("plan/check", { text: "# x\n", path: "x.md" });
    expect(out.result.ok).toBe(false);
  });
});

describe("orch RPC", () => {
  it("runs store ops and rejects unknown ones", async () => {
    const { mkdtempSync, rmSync, mkdirSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    mkdirSync("_tmp/test-runs", { recursive: true });
    const dir = mkdtempSync(resolve("_tmp/test-runs/orch-"));
    try {
      expect((await dispatch("orch/run", { store: dir, op: "init" })).error).toBeUndefined();
      const add: any = await dispatch("orch/run", { store: dir, op: "units.add", args: { id: "u1", track: "main", brief: "first" } });
      expect(add.error).toBeUndefined();
      const counts: any = await dispatch("orch/run", { store: dir, op: "units.counts" });
      expect(Object.values(counts.result).reduce((a: number, b: any) => a + b, 0)).toBeGreaterThanOrEqual(1);
      expect((await dispatch("orch/run", { store: dir, op: "merge" })).error?.message).toMatch(/^INVALID_INPUT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Ported from upstream check-plan.test.ts (pstack 0.15.29): fence handling, run in-process.
const rule =
	"Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.";

const validPlan = `# Demo

## How to read this
One box is one unit of work and names the evidence. Check a box only when its evidence exists. See playbooks/.
${rule}

## Program checklist
### Arm the program
### Spawn owners
### PR mechanics
### Verdict and merge
### Boot recipe
\`git show origin/main:\` /loop 1h status message

## PR 1
**Depends on.** None.
**Files.**
- [ ] Do the thing.
**Build.**
- [ ] Do the thing.
**You see.**
- [ ] Do the thing.
**Verify, unit.** ${rule}
- [ ] Check the thing.
**Verify, live.** ${rule} Ten lanes on \`example-model\` at the PR head
${Array.from({ length: 10 }, (_, i) => `- [ ] Lane ${i + 1}. Save \`lane-${i + 1}.png\`. Pass when evidence exists.`).join("\n")}
**Verify, perf.** ${rule}
- [ ] Metric. Recorded.
- [ ] Probe. Recorded.
- [ ] Baseline. Recorded.
- [ ] Rule. Recorded.
**Review gate.** None.
**Merge.**
- [ ] Merge when approved.

## Close the program
Close.

## Appendix Prototype evidence
Recorded.
`;

const runPlan = (example: string, expectedExit: number) => {
	const result = checkPlan(validPlan + example, "plan.md");
	expect(result.ok ? 0 : 1).toBe(expectedExit);
	return { stderr: result.problems.join("\n") };
};

describe("check-plan fences (upstream 0.15.29)", () => {
	it("accepts ordinary, indented, and longer closing fences", () => {
		for (const indent of ["", " ", "  ", "   "])
			runPlan(`${indent}\`\`\`markdown\n## Example only\n${indent}\`\`\`\n`, 0);
		runPlan("```markdown\n## Example only\n````\n", 0);
	});

	it("accepts nested backticks and tilde info strings", () => {
		runPlan("````markdown\n```markdown\n## Example only\n```\n````\n", 0);
		runPlan("~~~markdown `info`\n## Example only\n ~~~\n", 0);
	});

	it("keeps mismatched, shorter, and suffixed closers inside the fence", () => {
		runPlan("````markdown\n~~~\n## Example only\n````\n", 0);
		runPlan("````markdown\n```\n## Example only\n````\n", 0);
		runPlan("````markdown\n``` info\n## Example only\n````\n", 0);
	});

	it("rejects headings and prose outside a proper close", () => {
		for (const suffix of ["  ", "\t"]) {
			const heading = runPlan(`\`\`\`markdown\n## Example only\n\`\`\`${suffix}\n## Example only\n`, 1);
			expect(heading.stderr).toContain('"## Example only" after Close the program is not an appendix');
		}

		const prose = runPlan("```markdown\nThis prose has a mid-sentence colon: inside code\n```\nThis prose has a mid-sentence colon: bad.\n", 1);
		expect(prose.stderr).toContain("mid-sentence colon");
	});

	it("rejects backtick info strings containing a backtick", () => {
		const result = runPlan("```markdown `invalid`\n## Example only\n```\n", 1);
		expect(result.stderr).toContain('"## Example only" after Close the program is not an appendix');
	});
});
