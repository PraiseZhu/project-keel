**Keel 改写（优先于下文上游内容）**

跨多个 PR 的编排（orchestrate / autopilot-full / autopilot-stack）按用户既定流程交给现有流水线：`task-priority`（汇总任务优先级）→ `approve-exec`（批准执行）→ owner 会话。Keel 不另起编排，`pstack_start` 命中这些 playbook 时只返回交接指引与所需输入。若用户明确要求在单会话内跑：每个 owner 停在 merge-ready，报告给用户，由用户在 GitHub 合并；一 PR 一 owner，并行走 `fanout_plan` 生成的 Orca 车道。

---
