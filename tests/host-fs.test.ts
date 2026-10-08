import { describe, expect, it } from "vitest";
import { toChildEntries } from "../src/main/host-fs.ts";

describe("toChildEntries (real Cindy fs list shape)", () => {
  it("turns recursive file paths into direct child names", () => {
    const raw = {
      ok: true,
      entries: [
        { path: "runs/run-b/graph-state.json", bytes: 10, mtime: 1 },
        { path: "runs/run-a/graph-state.json", bytes: 10, mtime: 1 },
        { path: "runs/run-a/artifacts/verdict.json", bytes: 5, mtime: 1 },
        { path: "runs/run-a/decisions.jsonl", bytes: 5, mtime: 1 },
      ],
    } as never;
    expect(toChildEntries("runs", raw).entries).toEqual([{ name: "run-a" }, { name: "run-b" }]);
  });

  it("lists files directly under a flat directory", () => {
    const raw = { ok: true, entries: [{ path: "fanout/f1.json", bytes: 1, mtime: 1 }, { path: "fanout/f2.json", bytes: 1, mtime: 1 }] } as never;
    expect(toChildEntries("fanout", raw).entries).toEqual([{ name: "f1.json" }, { name: "f2.json" }]);
  });

  it("keeps already-normalized entries, failures, and empty lists as they are", () => {
    expect(toChildEntries("runs", { ok: true, entries: [{ name: "x" }] }).entries).toEqual([{ name: "x" }]);
    expect(toChildEntries("runs", { ok: false, message: "boom" })).toEqual({ ok: false, message: "boom" });
    expect(toChildEntries("runs", { ok: true, entries: [] }).entries).toEqual([]);
  });
});
