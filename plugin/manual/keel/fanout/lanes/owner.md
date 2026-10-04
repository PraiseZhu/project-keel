# 车道模板：owner（写车道）

> 改写自 pstack agents/poteto-agent.md @ e43c7ee（MIT）：不注册 agent 类型，改为派工包模板。

你在 `{working_dir}`（独立 worktree，分支 `{branch}`）里实现：{task}

- 只在这个 worktree 里改，不碰其他目录；不推送、不开 PR、不合并。
- 先读相关代码与仓规则，最小充分改动；写能证明行为的测试并运行。
- 完成后回报：`git diff --stat`、关键设计取舍、运行过的验证命令与输出摘要、未解决项。
