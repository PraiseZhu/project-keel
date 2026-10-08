/** Shared clock constants. Browser and Node both import this; no I/O. */

export const CLOCK_INTERVAL_MS = 15_000;
export const CLOCK_METHOD = "clock.tick";
export const CLOCK_PING_METHOD = "clock/ping";
export const CLOCK_WATCHDOG_MISSES = 3;
export const CLOCK_WATCHDOG_MS = CLOCK_INTERVAL_MS * CLOCK_WATCHDOG_MISSES;
export const CLOCK_STATUS_PATH = "clock-status.json";

export type ClockHealth = "unknown" | "running" | "crashed" | "restart_failed";
