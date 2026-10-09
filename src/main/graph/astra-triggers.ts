// Astra facts: cross-function, failure fingerprints.
// Pure: no I/O, no Jev.

/** Distinct module = first path segment (src/foo/bar → src/foo; foo.ts → foo). */
export function moduleOf(file: string): string {
  const f = file.replace(/^\.\//, "").replace(/\\/g, "/");
  const parts = f.split("/").filter(Boolean);
  if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return parts[0] ?? "";
}

/** Two or more distinct reported functions means the change crosses a function boundary. */
export const CROSS_MODULE_THRESHOLD = 2;

export type BoundaryFact = boolean | "unknown";

export function crossesFunctionBoundary(input: {
  functions_touched?: readonly string[] | null;
  files_changed?: readonly string[];
}): BoundaryFact {
  const names = (input.functions_touched ?? []).map((s) => s.trim()).filter(Boolean);
  if (!names.length) return "unknown";
  return new Set(names).size >= CROSS_MODULE_THRESHOLD;
}

/** Conservative: missing functions_touched is treated as crossing, so Astra still runs. */
export function crossesFunctionBoundaryOrUnknown(input: {
  functions_touched?: readonly string[] | null;
  files_changed?: readonly string[];
}): boolean {
  return crossesFunctionBoundary(input) !== false;
}

export function failureFingerprint(input: {
  findings?: readonly string[];
  ran?: readonly { cmd: string; exit_code: number }[];
  summary?: string;
}): string | undefined {
  const failed = (input.ran ?? []).filter((r) => r.exit_code !== 0).map((r) => r.cmd.trim().toLowerCase());
  if (failed[0]) return failed[0];
  const finding = (input.findings ?? []).map((s) => s.trim()).find(Boolean);
  if (finding) return finding.toLowerCase();
  const summary = input.summary?.trim();
  return summary ? summary.toLowerCase() : undefined;
}
