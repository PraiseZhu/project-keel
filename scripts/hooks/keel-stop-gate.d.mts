export const MARK: string;
export const ALLOW_STATUS: Set<string>;
export function parseArgs(argv: readonly string[]): { harness: string; index: string; timeoutMs: number };
export function matchWorkdir(cwd: string, index: unknown): Record<string, unknown> | null;
export function evaluate(event: unknown, index: unknown): { action: "allow"; why?: string } | { action: "block"; run_id: string; current_node: string };
export function formatOutput(harness: string, result: { action: string; run_id?: string; current_node?: string }): Record<string, unknown>;
export function emit(obj: unknown): void;
export function loadIndex(indexPath: string): Promise<unknown>;
export function runStopGate(opts: { harness: string; index: string; timeoutMs: number }, stdinText: string): Promise<Record<string, unknown>>;
