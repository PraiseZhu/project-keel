# 三 harness 回放矩阵

| 场景 | harness | 结果 | 说明 |
|---|---|---|---|
| S1 | claude-code | PASS | 见 S1.md；J1 低于阈值时关键词兜底到 investigation，目标仓无改动 |
| S3 | claude-code | FAIL | 只完成 fanout_plan；本会话是 Orca Worker，不能派发 Worker |
| S1 | codex | FAIL | 未执行：需要在 Codex 会话里跑（Worker 无法切换 harness） |
| S3 | codex | FAIL | 未执行：同上 |
| S1 | pi | FAIL | 未执行：需要在 Pi 会话里跑 |
| S3 | pi | FAIL | 未执行：同上 |

记录要求：每格写路由、实际派出的模型、Jev 调用次数与台账路径。
