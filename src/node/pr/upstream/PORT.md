# watch-pr 移植说明

来源：`cursor/plugins` 的 `pstack/skills/poteto-mode/scripts/watch-pr/`，commit `190d28736eff128ec94f502a22c7fe0c4b56cd37`，MIT（© 2026 Lauren Tan）。

`types.ts`、`policy.ts`、`render.ts`、`cli.ts`、`types.compile.ts` 原样保留。`github.ts` 唯一改动：进程调用改为可注入的 `setCommandRunner`，供 Cindy Node worker 补齐 `HOME`/`PATH` 并在目标仓目录运行；未注入时行为与上游一致。上游测试移植在 `tests/upstream/`，只改了导入路径与 `bun:test` → `vitest`。
