// Parse lane results. Pure functions: tests feed them recorded worker text.

export interface Finding {
  readonly file: string;
  readonly line: number | null;
  readonly title: string;
  readonly trigger?: string;
  readonly impact?: string;
  readonly evidence?: string;
  readonly severity_guess?: string;
}

export function jsonBlocks(text: string): unknown[] {
  const out: unknown[] = [];
  for (const m of text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)) {
    try {
      out.push(JSON.parse(m[1]!));
    } catch {
      /* not JSON: ignore */
    }
  }
  return out;
}

export function findingsOf(text: string): Finding[] {
  const out: Finding[] = [];
  for (const b of jsonBlocks(text)) {
    const arr = Array.isArray(b) ? b : b && typeof b === "object" && Array.isArray((b as any).findings) ? (b as any).findings : [];
    for (const f of arr) if (f && typeof f.file === "string" && typeof f.title === "string") out.push({ ...f, line: typeof f.line === "number" ? f.line : null });
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, " ").trim();
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });

function chineseTitleMatch(a: string, b: string): boolean {
  if (!/[一-鿿]/.test(a) || !/[一-鿿]/.test(b)) return false;
  const terms = (title: string) => [...new Set([...segmenter.segment(title.toLowerCase())]
    .filter((part) => part.isWordLike && part.segment.length > 1)
    .map((part) => part.segment))];
  const aTerms = terms(a);
  const bTerms = terms(b);
  const shorter = aTerms.length <= bTerms.length ? aTerms : bTerms;
  const longer = new Set(aTerms.length <= bTerms.length ? bTerms : aTerms);
  const shared = shorter.filter((term) => longer.has(term));
  // Shared context at the start alone must not merge findings with different outcomes.
  return shared.length >= 4
    && shared.length >= Math.ceil(shorter.length / 2)
    && shorter.slice(-Math.ceil(shorter.length / 3)).filter((term) => longer.has(term)).length >= 2;
}

export interface Merged {
  readonly id: string;
  readonly finding: Finding;
  readonly lanes: string[];
  readonly guesses: string[];
}

/** Same file, lines within 3, and overlapping title terms → same finding. */
export function dedupe(perLane: { label: string; findings: Finding[] }[]): Merged[] {
  const merged: { id: string; finding: Finding; lanes: string[]; guesses: string[] }[] = [];
  for (const { label, findings } of perLane) {
    for (const f of findings) {
      const words = new Set(norm(f.title).split(" ").filter((w) => w.length > 2));
      const hit = merged.find((m) => {
        if (m.finding.file !== f.file) return false;
        if (m.finding.line !== null && f.line !== null && Math.abs(m.finding.line - f.line) > 3) return false;
        const other = norm(m.finding.title).split(" ").filter((w) => w.length > 2);
        const overlap = other.filter((w) => words.has(w)).length;
        return overlap >= Math.min(2, Math.max(1, Math.min(words.size, other.length)))
          || chineseTitleMatch(m.finding.title, f.title);
      });
      if (hit) {
        if (!hit.lanes.includes(label)) hit.lanes.push(label);
        if (f.severity_guess) hit.guesses.push(f.severity_guess);
      } else merged.push({ id: `f${merged.length + 1}`, finding: f, lanes: [label], guesses: f.severity_guess ? [f.severity_guess] : [] });
    }
  }
  return merged;
}

export function classifyAgreement(m: Merged): "consensus" | "single" | "disputed" {
  if (new Set(m.guesses).size > 1) return "disputed";
  return m.lanes.length >= 2 ? "consensus" : "single";
}

export type SwarmVerdict = "PASS" | "ISSUES" | "BLOCKED";

export function swarmRow(label: string, text: string): { label: string; verdict: SwarmVerdict | null; sha: string | null; has_method: boolean; gap: string | null } {
  const v = text.match(/VERDICT:\s*(PASS|ISSUES|BLOCKED)/i)?.[1]?.toUpperCase() as SwarmVerdict | undefined;
  const sha = text.match(/\b[0-9a-f]{7,40}\b/)?.[0] ?? null;
  const hasMethod = /```|`[^`]*(npm|npx|node|pytest|go test|cargo|make|vitest|curl)[^`]*`|命令|command:/i.test(text);
  const gaps = [!v && "缺 VERDICT", !sha && "缺 commit SHA", !hasMethod && "缺验证方法"].filter(Boolean);
  return { label, verdict: v ?? null, sha, has_method: hasMethod, gap: gaps.length ? gaps.join("、") : null };
}

export function crossJudge(text: string): { base: string | null; graft: unknown[]; reasons: unknown[] } {
  for (const b of jsonBlocks(text)) if (b && typeof b === "object" && typeof (b as any).base === "string") return { base: (b as any).base, graft: (b as any).graft ?? [], reasons: (b as any).reasons ?? [] };
  return { base: null, graft: [], reasons: [] };
}
