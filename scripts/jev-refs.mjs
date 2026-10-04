// Shared by jev-refs-check.mjs and jev-migrate.mjs: which files still reference the old
// typesafe-jev plugin, and how a line migrates to keel/jev (parameters unchanged).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function loadRefs() {
  const local = "config/profile.local.json";
  if (!existsSync(local)) throw new Error("config/profile.local.json is required (jevRefs)");
  const r = JSON.parse(readFileSync(local, "utf8")).jevRefs ?? { files: [], repos: [], checkOnly: [] };
  const fromRepos = r.repos.flatMap((repo) =>
    execFileSync("git", ["-C", repo, "grep", "-l", "-e", "typesafe-jev", "-e", "tool=evaluate"], { encoding: "utf8" }).split("\n").filter(Boolean).map((f) => join(repo, f)),
  );
  return { targets: [...new Set([...r.files, ...fromRepos])].filter((f) => !/\/archive\//.test(f)), checkOnly: r.checkOnly ?? [], repos: r.repos };
}

const TRIGGER = /typesafe-jev|tool=evaluate|tool: evaluate|"tool": "evaluate"|`evaluate`/;

/** Only lines that talk about the Jev plugin change; everything else stays byte-identical. */
export function migrateText(text) {
  return text
    .split("\n")
    .map((line) =>
      TRIGGER.test(line)
        ? line
            .replace(/typesafe-jev/g, "keel")
            .replace(/tool=evaluate/g, "tool=jev")
            .replace(/tool: evaluate/g, "tool: jev")
            .replace(/"tool": "evaluate"/g, '"tool": "jev"')
            .replace(/`evaluate`/g, "`jev`")
            .replace(/keel evaluate/g, "keel jev")
        : line,
    )
    .join("\n");
}

export function countOld(text) {
  return (text.match(/typesafe-jev/g) ?? []).length;
}
