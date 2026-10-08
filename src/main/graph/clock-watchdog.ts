// Browser-side fallback when the resident Node clock goes silent.
// clock.tick is the primary period; this watchdog only scans after CLOCK_WATCHDOG_MS without a tick.

import {
  CLOCK_INTERVAL_MS,
  CLOCK_PING_METHOD,
  CLOCK_STATUS_PATH,
  CLOCK_WATCHDOG_MS,
  type ClockHealth,
} from "../../shared/clock.ts";

export { CLOCK_INTERVAL_MS, CLOCK_PING_METHOD, CLOCK_STATUS_PATH, CLOCK_WATCHDOG_MS };
export type { ClockHealth };

export type ClockStatus = { state: ClockHealth; at: number; error?: string };

export function isNodeClockNotification(msg: { type?: string; name?: string; method?: string } | null | undefined): boolean {
  return msg?.type === "event" && msg.name === "node-notification" && msg.method === "clock.tick";
}

export function isNodeCrashedStatus(msg: { type?: string; name?: string; state?: string } | null | undefined): boolean {
  return msg?.type === "event" && msg.name === "node-status" && msg.state === "crashed";
}

export class ClockWatchdog {
  private lastTickAt: number | null = null;
  private lastFallbackAt: number | null = null;
  private readonly startedAt: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly ports: {
      now: () => number;
      scan: () => Promise<unknown>;
      ping: () => Promise<{ ok: boolean; message?: string }>;
      log?: (line: string) => void;
      persist?: (status: ClockStatus) => Promise<void>;
      intervalMs?: number;
      watchdogMs?: number;
    },
  ) {
    this.startedAt = ports.now();
  }

  markStale(): void {
    const gap = this.ports.watchdogMs ?? CLOCK_WATCHDOG_MS;
    this.lastTickAt = this.ports.now() - gap;
  }

  async handle(msg: { type?: string; name?: string; method?: string; state?: string }): Promise<{ handled: boolean }> {
    if (isNodeClockNotification(msg)) {
      this.lastTickAt = this.ports.now();
      await this.persist({ state: "running", at: this.lastTickAt });
      await this.ports.scan();
      return { handled: true };
    }
    if (isNodeCrashedStatus(msg)) {
      await this.persist({ state: "crashed", at: this.ports.now() });
      this.ports.log?.("KEEL：常驻 Node 时钟崩溃，正在 clock/ping 拉起。");
      const r = await this.ports.ping();
      if (!r.ok) {
        const error = r.message ?? "ping_failed";
        this.ports.log?.(`KEEL：常驻 Node 拉起失败：${error}`);
        await this.persist({ state: "restart_failed", at: this.ports.now(), error });
      } else {
        await this.persist({ state: "running", at: this.ports.now() });
      }
      return { handled: true };
    }
    return { handled: false };
  }

  async check(): Promise<void> {
    const now = this.ports.now();
    const gap = this.ports.watchdogMs ?? CLOCK_WATCHDOG_MS;
    const last = this.lastTickAt ?? this.startedAt;
    if (now - last < gap) return;
    if (this.lastFallbackAt !== null && now - this.lastFallbackAt < gap) return;
    this.lastFallbackAt = now;
    await this.ports.scan();
  }

  start(): void {
    if (this.timer) return;
    const interval = this.ports.intervalMs ?? CLOCK_INTERVAL_MS;
    this.timer = setInterval(() => { void this.check(); }, interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async persist(status: ClockStatus): Promise<void> {
    if (this.ports.persist) await this.ports.persist(status);
  }
}
