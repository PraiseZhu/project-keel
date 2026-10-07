import { describe, expect, it } from "vitest";
import { graphStatePath, withRun } from "../src/main/store/runs.ts";
import { fakeHost } from "./helpers/fakeHost.ts";

describe("withRun", () => {
  it("serializes concurrent updates so none are dropped", async () => {
    const h = fakeHost();
    await Promise.all(
      Array.from({ length: 8 }, () =>
        withRun(h, "run-a", async (state) => {
          const n = Number(state.n ?? 0);
          await new Promise((r) => setTimeout(r, 5));
          state.n = n + 1;
        }),
      ),
    );
    const stored = JSON.parse(h.files.get(graphStatePath("run-a"))!);
    expect(stored.n).toBe(8);
    expect(stored.run_id).toBe("run-a");
  });

  it("keeps distinct runs independent and does not write on fn throw", async () => {
    const h = fakeHost();
    await withRun(h, "run-a", (s) => {
      s.n = 1;
    });
    await expect(
      withRun(h, "run-a", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(JSON.parse(h.files.get(graphStatePath("run-a"))!).n).toBe(1);

    await withRun(h, "run-a", (s) => {
      s.n = Number(s.n) + 1;
    });
    expect(JSON.parse(h.files.get(graphStatePath("run-a"))!).n).toBe(2);

    await Promise.all([
      withRun(h, "run-a", async (s) => {
        await new Promise((r) => setTimeout(r, 15));
        s.mark = "a";
      }),
      withRun(h, "run-b", (s) => {
        s.mark = "b";
      }),
    ]);
    expect(JSON.parse(h.files.get(graphStatePath("run-a"))!).mark).toBe("a");
    expect(JSON.parse(h.files.get(graphStatePath("run-b"))!).mark).toBe("b");
  });
});
