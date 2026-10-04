# 并行派工协议（arena / interrogate / swarm）

`fanout_plan` 只做规划，不派发：Keel 插件不能自己开 Orca Worker，派发由主 Agent 执行。

## 步骤

1. `fanout_plan({ kind, task, repo_dir, run_id, lanes?, slices?, lead_agent?, lead_model? })`。Keel 现读 routing.json：
   - arena 候选与 interrogate 审查车道依次取：A 席＝审核档（传了 `lead_agent` 且存在 `review.when_lead.<lead_agent>` 时取该覆盖，否则取顶层 `review`）、B 席＝`execute` 主档、C 席＝另一个与 A/B 不同家族的审核变体（顶层 `review` 或其他 lead 的覆盖），形成三个模型家族；找不到第三家族时 C 席与 A 席同模型并标注。`lead_model` 只用于让裁判席避开 lead 的模型家族。
   - swarm 切片取 `execute`；验证车道取 `e2e`。
   - 写车道（arena 候选、swarm 切片）由 Keel 预建 `<仓>/.worktrees/pstack-<fanout_id>-<label>/`，分支 `pstack/<fanout_id>/<label>`。
2. 主 Agent：`start_team({ worker_permission_mode: "bypassPermissions" })`，然后把返回的 `create_workers` 参数原样传给 `create_workers`。派发说明为每个 Worker 标注 `(model/effort)`；有降级时写明原因。
3. 每个 Worker 按 `output_contract` 回报。主 Agent 收齐后调 `fanout_ingest({ fanout_id, kind, repo_dir, lane_results })`。
4. arena：Keel 收集各 worktree 的 diff，Jev J3 选基础候选；主 Agent 把它与自评、交叉评审对照后决定，再嫁接其他候选的优点。interrogate：解析各审查车道的 JSON 发现，去重后 J4 统一分级，输出共识 / 单模型 / 分歧。swarm：PASS / ISSUES / BLOCKED 表，缺 SHA 或验证方法的结果判为缺口。
5. `fanout_ingest({ ..., cleanup: true })` 只清理本次 fanout 的干净 worktree。

## 失败处理

- routing.json 不可读或某档缺 agent/model → `ROUTING_UNREADABLE`，停下回报，不自找替代。
- primary 报 `NO_PROVIDER_FOR_AGENT` / `PROVIDER_ROUTE_UNAVAILABLE` / `BUDGET_MODEL_REQUIRES_API_MODE` → 按 `fallbacks` 顺序降级；用尽即停。
- 当前 harness 没有 Orca：只能用原生 subagent 做只读车道，并明确写“同模型降级，非多模型”。

## 车道模板

`keel/fanout/lanes/` 下：`owner.md`、`comment-sicko.md`、`reviewer.md`、`cross-judge.md`、`explorer.md`、`verifier.md`。`fanout_plan` 返回的每条车道 `prompt` 已按模板填好。
