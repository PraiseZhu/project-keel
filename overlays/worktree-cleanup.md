**Keel 改写（优先于下文上游内容）**

- worktree 一律放在 `<仓>/.worktrees/`。审计用 `worktree({op:"audit"})`（只读）。
- 删除用 `worktree({op:"prune"})`：**只删审计为 `safe` 的行（工作区干净且已合并）**；含 tracked 改动、PR 仍开、近期在用的行一律拒删；删前弹确认列出路径；使用 `git worktree remove` 与 `git branch -d`，不用 `--force`、不用 `rm -rf`。

---
