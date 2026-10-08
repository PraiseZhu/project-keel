// Astra three-point facts: cross-function, failure fingerprints, final-review skip.
// Pure: no I/O, no Jev.

const TEST_OR_DOC = /(?:^|\/)(?:tests?|docs?|documentation)\//i;
const DOC_EXT = /\.(md|txt|rst|adoc)$/i;
const TEST_FILE = /\.(?:test|spec)\.[a-z0-9]+$/i;

/** Distinct module = first path segment (src/foo/bar → src/foo; foo.ts → foo). */
export function moduleOf(file: string): string {
  const f = file.replace(/^\.\//, "").replace(/\\/g, "/");
  const parts = f.split("/").filter(Boolean);
  if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return parts[0] ?? "";
}

export function isTestOrDoc(file: string): boolean {
  const f = file.replace(/\\/g, "/");
  return TEST_OR_DOC.test(f) || DOC_EXT.test(f) || TEST_FILE.test(f);
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

/** ≤30 lines and only tests/docs: skip astra-final-review (plan Step 7). Unknown line count must not skip. */
export const FINAL_REVIEW_LINE_SKIP = 30;

export function shouldSkipFinalReview(files: readonly string[], changedLines?: number): boolean {
  if (!files.length) return false;
  if (!files.every(isTestOrDoc)) return false;
  if (changedLines === undefined || !Number.isFinite(changedLines)) return false;
  return changedLines <= FINAL_REVIEW_LINE_SKIP;
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
