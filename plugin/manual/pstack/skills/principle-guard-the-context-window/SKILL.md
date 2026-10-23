> 移植自 pstack skills/principle-guard-the-context-window/SKILL.md @ 190d287（MIT）。改写：仅宿主名词替换

> 上游说明（principle-guard-the-context-window）：Apply when context is filling up: large outputs, long files, repeated reads, fan-out planning. Route bulk to subagents; keep summaries in the main thread, not raw payloads.

# Guard the Context Window

**Why:** Context overflow degrades reasoning quality, creates compression artifacts, and halts progress.

**Pattern:**
- **Size phases and cap scope.** Limit files per phase, set turn budgets, account for mechanism costs.
