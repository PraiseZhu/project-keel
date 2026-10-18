import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("dashboard plugin contract", () => {
  it("serves the same real dashboard from the dock and main view without the old scheduled panel actions", () => {
    const manifest = JSON.parse(readFileSync("plugin/ghost.json", "utf8"));
    expect(manifest.panel.html).toBe("panel.html");
    expect(manifest.mainView.html).toBe("panel.html");
    expect(manifest.agent.schedule).toBeUndefined();
    expect(existsSync("src/panel/graph-view.ts")).toBe(false);
    expect(existsSync("plugin/graph-view.html")).toBe(false);
    expect(readFileSync("src/main/index.ts", "utf8")).not.toMatch(/message\.op === ["'](?:ledger|schedule|fanout|roles)["']/);
    expect(readFileSync("src/panel/panel.ts", "utf8")).toContain('fetch("/wake"');
    expect(readFileSync("src/panel/panel.ts", "utf8")).not.toContain("__KEEL_PREVIEW__");
  });
  it("declares structured progress and complete cross-repository pagination", () => {
    const manifest = JSON.parse(readFileSync("plugin/ghost.json", "utf8"));
    const report = manifest.tools.find((tool: { name: string }) => tool.name === "keel_report");
    expect(report.parameters.properties.phase.enum).toContain("progress");
    expect(report.parameters.properties.step).toMatchObject({ type: "integer", minimum: 1, maximum: 8 });
    const board = manifest.tools.find((tool: { name: string }) => tool.name === "pr_status");
    expect(board.parameters.properties.scope.enum).toEqual(["open", "all"]);
    expect(board.description).toContain("complete:false");
  });
});
