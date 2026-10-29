**Keel 改写（优先于下文上游内容）**

跨多个 PR 的编排（orchestrate / autopilot-full / autopilot-stack）按用户既定流程：先用 `open-issue` 建总 issue 和子 issue，再「批准执行」（`approve-exec`）给每个子 issue 开一个 owner 会话，owner 会话用 `keel_run` 推进。Keel 不另起编排，也不为这些 playbook 单独返回交接指引：`pstack_start` 只是 `keel_run` 的迁移入口，照常开 KEEL run。若用户明确要求在单会话内跑：每个 owner 停在 merge-ready，报告给用户，由用户在 GitHub 合并；一 PR 一 owner，并行走 `fanout({ op: "plan" })` 生成的 Orca 车道。

---
