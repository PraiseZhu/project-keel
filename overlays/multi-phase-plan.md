**Keel 改写（优先于下文上游内容）**

计划文件落在本机配置的计划目录（见 `keel/profile.md`）或目标仓 `docs/`。`check-plan` 用插件自带的 Node 脚本运行：`node <keel>/node/check-plan.mjs <plan.md>`（`<keel>` 的取法见 `keel/MANUAL.md`，不需要 bun）。心跳一项写 Cindy `schedule_create`，与上游 `/loop 1h` 等价。计划写完先给用户审阅，批准后才执行。

---
