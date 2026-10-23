> 移植自 pstack skills/principle-laziness-protocol/SKILL.md @ 190d287（MIT）。改写：仅宿主名词替换

> 上游说明（principle-laziness-protocol）：Apply when refactoring, evaluating diff size, or tempted to add abstractions, layers, or signal threading. Bias toward deletion and the smallest change that solves the problem.

# Laziness Protocol

- **Consolidate decisions.** Do not repeat the same choice in several places. Put it behind one source of truth and pass the result as a simple flag.
- **Minimize the diff.** Make the smallest change that solves the problem. Fewer lines beat "elegant" boilerplate.
