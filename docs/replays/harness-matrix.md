# 三 harness 回放矩阵

| 场景 | harness | 结果 | 说明 |
|---|---|---|---|
| S1 | claude-code | PASS | 见 S1.md；J1 低于阈值时关键词兜底到 investigation，目标仓无改动 |
| S3 | claude-code | PASS | lead 会话：pstack_start（Jev 2 次）→ fanout_plan `fo-2610041301-214` → 派 3 车道（gpt-6-sol / grok-4.6 / glm-5.3）→ fanout_ingest（J4 1 次）；台账 `run-20261004130134-404f` |
| S1 | codex | PASS | Worker keel-h-codex（codex / grok-4.6 / high）：investigation（keyword，J1 0.55），Jev 2 次；Project CINDY HEAD 与 status hash 前后一致；台账 `run-20261004130500-443b` |
| S3 | codex | PASS | 同 Worker：fanout_plan `fo-2610041306-229` 三车道参数与共用规划一致；对共用车道结果 ingest 计数与 lead 一致；Jev 3 次（J1/J2/J4）；台账 `run-20261004130618-e417` |
| S1 | pi | PASS | Worker keel-h-pi（pi / grok-4.6 / high）：investigation（keyword，J1 0.51），Jev 2 次；目标仓前后一致；台账 `run-20261004130523-f6cb` |
| S3 | pi | PASS | 同 Worker：fanout_plan `fo-2610041306-e4c` 参数一致；ingest 计数与 lead 一致；Jev 3 次；台账 `run-20261004130637-82ce` |

记录要求：每格写路由、实际派出的模型、Jev 调用次数与台账路径。

说明：
- S3 三个 harness 共用 lead 派出的同一组审查车道（用户 2026-10-04 选定“共用车道”）。每个 harness 独立跑 pstack_start、fanout_plan，并对同一批车道结果各做一次 fanout_ingest；车道本身只派一次。
- harness 差异：Codex 的命令输出需经 JS 包装取回；上游 how 流程要派 explainer 子代理，Codex、Pi 下均改为单程只读调查。
- 三个 harness 的 S3 路由都落到 figure-it-out（Jev 低于阈值、关键词未识别“三个模型”），不影响 fanout 结果。
