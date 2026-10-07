import { describe, expect, it } from "vitest";
import { append, read } from "../src/main/ledger.ts";
import { fakeHost } from "./helpers/fakeHost.ts";

describe("ledger serial writes", () => {
  it("keeps every row when many appends race on the same run", async () => {
    const h = fakeHost();
    const inner = h.fs.bind(h);
    h.fs = async (req) => {
      await new Promise((r) => setTimeout(r, 8));
      return inner(req);
    };
    const n = 20;
    await Promise.all(Array.from({ length: n }, (_, i) => append(h, { run_id: "run-concurrent-a", kind: "step", summary: `row-${i}` })));
    const rows = await read(h, "run-concurrent-a", 100);
    expect(rows).toHaveLength(n);
    expect(new Set(rows.map((r) => r.row_id)).size).toBe(n);
    expect(new Set(rows.map((r) => r.summary)).size).toBe(n);
    const stored = h.files.get("runs/run-concurrent-a/decisions.jsonl")!.trim().split("\n");
    expect(stored).toHaveLength(n);
  });

  it("does not share the queue across different runs", async () => {
    const h = fakeHost();
    await Promise.all([
      append(h, { run_id: "run-concurrent-b", kind: "step", summary: "b1" }),
      append(h, { run_id: "run-concurrent-c", kind: "step", summary: "c1" }),
    ]);
    expect(await read(h, "run-concurrent-b", 10)).toHaveLength(1);
    expect(await read(h, "run-concurrent-c", 10)).toHaveLength(1);
  });
});
