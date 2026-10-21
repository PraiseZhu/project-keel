> 移植自 pstack skills/principle-migrate-callers-then-delete-legacy-apis/SKILL.md @ 190d287（MIT）。改写：仅宿主名词替换

> 上游说明（principle-migrate-callers-then-delete-legacy-apis）：Apply when introducing a new internal API while old callers still exist. Migrate callers and delete the old API in the same wave instead of preserving compatibility layers.

# Migrate Callers Then Delete Legacy APIs

- Update tests to assert the new contract, and delete tests that only protect pre-refactor implementation details

**When this applies:**
- No external users depend on backward compatibility
- The project can absorb coordinated breaking changes
- The new API is part of a simplification or refactor initiative
