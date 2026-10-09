// Scope check: changed files must match at least one allow glob.

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/\\/g, "/").replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = escaped.replace(/\*\*\//g, "\0").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*").replace(/\0/g, "(?:.*/)?");
  return new RegExp(`^${body}$`);
}

export function matchScopeGlob(file: string, pattern: string): boolean {
  // Git -z output already uses "/" between directories; a backslash is part of a POSIX file name.
  const f = file.replace(/^\.\//, "");
  const p = pattern.replace(/\\/g, "/");
  if (p.endsWith("/")) return f === p.slice(0, -1) || f.startsWith(p);
  if (p.endsWith("/**")) {
    const root = p.slice(0, -3);
    return f === root || f.startsWith(`${root}/`);
  }
  return globToRegExp(p).test(f);
}

export function checkScope(changedFiles: readonly string[], scopeGlobs: readonly string[]): { ok: boolean; violations: string[] } {
  const files = changedFiles.map((f) => f.replace(/^\.\//, ""));
  if (!scopeGlobs.length) return { ok: files.length === 0, violations: [...files] };
  const violations = files.filter((f) => !scopeGlobs.some((g) => matchScopeGlob(f, g)));
  return { ok: violations.length === 0, violations };
}
