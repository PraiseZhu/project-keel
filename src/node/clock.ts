// Resident Node clock: JSON-RPC notifications the host forwards as node-notification.
// Spike P0-5: 15s interval, no request id. Does not drive nudge itself.

export const CLOCK_INTERVAL_MS = 15_000;
export const CLOCK_METHOD = "clock.tick";

export type ClockNotification = {
  jsonrpc: "2.0";
  method: typeof CLOCK_METHOD;
  params: { at: number; count: number };
};

export function startNodeClock(opts?: {
  intervalMs?: number;
  now?: () => number;
  emit?: (msg: ClockNotification) => void;
}): { stop(): void } {
  const intervalMs = opts?.intervalMs ?? CLOCK_INTERVAL_MS;
  const now = opts?.now ?? (() => Date.now());
  const emit = opts?.emit ?? defaultEmit;
  let count = 0;
  const timer = setInterval(() => {
    count += 1;
    emit({ jsonrpc: "2.0", method: CLOCK_METHOD, params: { at: now(), count } });
  }, intervalMs);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

function defaultEmit(msg: ClockNotification): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
