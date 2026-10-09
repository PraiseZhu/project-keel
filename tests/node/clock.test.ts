import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CLOCK_INTERVAL_MS, CLOCK_METHOD, startNodeClock } from "../../src/node/clock.ts";

describe("resident Node clock", () => {
  it("emits clock.tick JSON-RPC notifications every 15s without an id", () => {
    expect(CLOCK_INTERVAL_MS).toBe(15_000);
    expect(CLOCK_METHOD).toBe("clock.tick");
    vi.useFakeTimers();
    const sent: unknown[] = [];
    const clock = startNodeClock({
      now: () => 1_000,
      emit: (msg) => sent.push(msg),
    });
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(14_999);
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ jsonrpc: "2.0", method: "clock.tick", params: { at: 1_000, count: 1 } });
    expect((sent[0] as { id?: unknown }).id).toBeUndefined();
    vi.advanceTimersByTime(15_000);
    expect(sent).toHaveLength(2);
    expect((sent[1] as { params: { count: number } }).params.count).toBe(2);
    clock.stop();
    vi.advanceTimersByTime(15_000);
    expect(sent).toHaveLength(2);
    vi.useRealTimers();
  });

  it("manifest Node worker is resident and has no idle timeout", () => {
    const ghost = JSON.parse(readFileSync("plugin/ghost.json", "utf8")) as {
      launch?: string;
      node?: { lifecycle?: string; idleTimeoutSeconds?: number };
    };
    expect(ghost.node?.lifecycle).toBe("resident");
    expect(ghost.node?.idleTimeoutSeconds).toBeUndefined();
  });
});
