// Browser-side fallback when the resident Node clock goes silent.
// clock.tick is the primary period; this watchdog only scans after CLOCK_WATCHDOG_MS without a tick.
// crashed → ping is single-flight, backoff, and capped so a start-failure loop cannot ping forever.

import {
  CLOCK_INTERVAL_MS,
  CLOCK_PING_BACKOFF_MS,
  CLOCK_PING_MAX_FAILURES,
  CLOCK_PING_METHOD,
  CLOCK_STATUS_PATH,
  CLOCK_WATCHDOG_MS,
  type ClockHealth,
} from "../../shared/clock.ts";

export { CLOCK_INTERVAL_MS, CLOCK_PING_METHOD, CLOCK_STATUS_PATH, CLOCK_WATCHDOG_MS, CLOCK_PING_MAX_FAILURES, CLOCK_PING_BACKOFF_MS };
export type { ClockHealth };

export type ClockStatus = {
  state: ClockHealth;
  at: number;
  error?: string;
  failCount?: number;
  nextAllowedPingAt?: number;
};

export function isNodeClockNotification(msg: { type?: string; name?: string; method?: string } | null | undefined): boolean {
  return msg?.type === "event" && msg.name === "node-notification" && msg.method === "clock.tick";
}

export function isNodeCrashedStatus(msg: { type?: string; name?: string; state?: string } | null | undefined): boolean {
  return msg?.type === "event" && msg.name === "node-status" && msg.state === "crashed";
}

export class ClockWatchdog {
  private lastTickAt: number | null = null;
  private lastFallbackAt: number | null = null;
  private failCount = 0;
  private nextAllowedPingAt: number | null = null;
  private pingInFlight = false;
  private readonly startedAt: number;
  private readonly ready: Promise<void> | null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly ports: {
      now: () => number;
      scan: () => Promise<unknown>;
      ping: () => Promise<{ ok: boolean; message?: string }>;
      log?: (line: string) => void;
      persist?: (status: ClockStatus) => Promise<void>;
      load?: () => Promise<ClockStatus | null | undefined>;
      initial?: ClockStatus;
      intervalMs?: number;
      watchdogMs?: number;
    },
  ) {
    this.startedAt = ports.now();
    if (ports.initial) this.applyPersisted(ports.initial);
    this.ready = ports.load
      ? ports.load().then((s) => { if (s) this.applyPersisted(s); }).catch(() => undefined)
      : null;
  }

  markStale(): void {
    const gap = this.ports.watchdogMs ?? CLOCK_WATCHDOG_MS;
    this.lastTickAt = this.ports.now() - gap;
  }

  async handle(msg: { type?: string; name?: string; method?: string; state?: string }): Promise<{ handled: boolean }> {
    if (this.ready) await this.ready;
    if (isNodeClockNotification(msg)) {
      this.lastTickAt = this.ports.now();
      this.resetFailures();
      await this.persist(this.snapshot("running"));
      await this.ports.scan();
      return { handled: true };
    }
    if (isNodeCrashedStatus(msg)) {
      await this.persist(this.snapshot("crashed"));
      await this.pingIfAllowed();
      return { handled: true };
    }
    return { handled: false };
  }

  async check(): Promise<void> {
    if (this.ready) await this.ready;
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

  private applyPersisted(status: ClockStatus): void {
    this.failCount = typeof status.failCount === "number" && status.failCount >= 0 ? status.failCount : 0;
    this.nextAllowedPingAt = typeof status.nextAllowedPingAt === "number" ? status.nextAllowedPingAt : null;
  }

  private resetFailures(): void {
    this.failCount = 0;
    this.nextAllowedPingAt = null;
  }

  private snapshot(state: ClockHealth, error?: string): ClockStatus {
    return {
      state,
      at: this.ports.now(),
      ...(error ? { error } : {}),
      failCount: this.failCount,
      ...(this.nextAllowedPingAt !== null ? { nextAllowedPingAt: this.nextAllowedPingAt } : {}),
    };
  }

  private async pingIfAllowed(): Promise<void> {
    if (this.pingInFlight) return;
    if (this.failCount >= CLOCK_PING_MAX_FAILURES) {
      this.ports.log?.("KEEL：常驻 Node 拉起失败，需要手动重新启用插件。");
      await this.persist(this.snapshot("restart_failed", "需要手动重新启用插件"));
      return;
    }
    const now = this.ports.now();
    if (this.nextAllowedPingAt !== null && now < this.nextAllowedPingAt) return;
    this.pingInFlight = true;
    this.ports.log?.("KEEL：常驻 Node 时钟崩溃，正在 clock/ping 拉起。");
    try {
      let r: { ok: boolean; message?: string };
      try {
        r = await this.ports.ping();
      } catch (e) {
        r = { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
      if (!r.ok) {
        this.failCount += 1;
        const error = r.message ?? "ping_failed";
        if (this.failCount >= CLOCK_PING_MAX_FAILURES) {
          this.nextAllowedPingAt = null;
          this.ports.log?.("KEEL：常驻 Node 拉起失败，需要手动重新启用插件。");
          await this.persist(this.snapshot("restart_failed", "需要手动重新启用插件"));
        } else {
          this.nextAllowedPingAt = now + CLOCK_PING_BACKOFF_MS[this.failCount - 1]!;
          this.ports.log?.(`KEEL：常驻 Node 拉起失败：${error}`);
          await this.persist(this.snapshot("restart_failed", error));
        }
      } else {
        this.resetFailures();
        await this.persist(this.snapshot("running"));
      }
    } finally {
      this.pingInFlight = false;
    }
  }

  private async persist(status: ClockStatus): Promise<void> {
    if (this.ports.persist) await this.ports.persist(status);
  }
}
