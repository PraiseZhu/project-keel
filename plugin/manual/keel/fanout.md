# 并行派工协议（arena / interrogate / swarm）

`fanout_plan` 只做规划，不派发：Keel 插件不能自己开 Orca Worker，派发由主 Agent 执行。

## 步骤

1. `fanout_plan({ kind, task, repo_dir, run_id, lead_agent, lanes?, slices?, lead_model?, user_requested? })`。`lead_agent` 必填（无法确认就先问）。本地多模型审查默认关闭的车道只有用户点名才跑，此时传 `user_requested:true`。Keel 现读 routing.json：
   - arena 候选与 interrogate 审查车道依次取：A 席＝审核档（存在 `review.when_lead.<lead_agent>` 时取该覆盖，否则取顶层 `review`）、B 席＝`execute` 主档、C 席＝另一个与 A/B 不同家族的审核变体（顶层 `review` 或其他 lead 的覆盖），形成三个模型家族；找不到第三家族时 C 席与 A 席同模型并标注。`lead_model` 只用于让裁判席避开 lead 的模型家族。
   - swarm 切片取 `execute`；验证车道取 `e2e`。
   - 写车道（arena 候选、swarm 切片）由 Keel 预建 `<仓>/.worktrees/pstack-<fanout_id>-<label>/`，分支 `pstack/<fanout_id>/<label>`，起点固定为规划时解析出的 `base_sha`。
   - interrogate 的只读审查车道留在调用方传入的 `repo_dir`（可以是功能 worktree），审查范围写死为 `git diff <base_sha>...<当前 HEAD>`。
2. 主 Agent：`start_team({ worker_permission_mode: "bypassPermissions" })`，然后分两段派发（同上游 arena / swarm 的先后）：
   - 第一段：`create_workers.workers`（候选、切片、审查车道）原样派发；派发说明为每个 Worker 标注 `(model/effort)`，有降级时写明原因。
   - 第二段：`create_workers.after_stage1`（交叉评审、验证车道）等第一段全部回报后再派；它的指令里已列出各候选 / 切片的 worktree 与分支。
3. 每个 Worker 按 `output_contract` 回报。主 Agent 收齐后调 `fanout_ingest({ fanout_id, kind, repo_dir, lane_results })`。
4. arena：Keel 收集各 worktree 的 diff，Jev J3 选基础候选；主 Agent 把它与自评、交叉评审对照后决定，再嫁接其他候选的优点。interrogate：解析各审查车道的 JSON 发现，去重后 J4 统一分级，输出共识 / 单模型 / 分歧。swarm：PASS / ISSUES / BLOCKED 表，缺 SHA 或验证方法的结果判为缺口。
   interrogate 有车道没回报或回报里没有 JSON 块时，结果里的 `gaps` 会列出来，`complete:false`，不当成 0 条发现。
5. `fanout_ingest({ ..., cleanup: true })` 先弹确认，再按与 `worktree` 清理相同的审计规则清本次 fanout 的 worktree：有未提交改动或 open PR 的保留，未合并分支保留。

## 失败处理

- routing.json 不可读或某档缺 agent / model / effort → `ROUTING_UNREADABLE`，停下回报，不自找替代。
- primary 报 `NO_PROVIDER_FOR_AGENT` / `PROVIDER_ROUTE_UNAVAILABLE` / `BUDGET_MODEL_REQUIRES_API_MODE` → 按 `fallbacks` 顺序降级；用尽即停。
- 当前 harness 没有 Orca：只能用原生 subagent 做只读车道，并明确写“同模型降级，非多模型”。

## 车道模板

`keel/fanout/lanes/` 下：`owner.md`、`comment-sicko.md`、`reviewer.md`、`cross-judge.md`、`explorer.md`、`verifier.md`，是各角色的职责说明（改写自上游 agents）。`fanout_plan` 返回的 `prompt` 由代码生成，带任务、范围、输出契约与规则；派工时可把对应模板作为补充说明附上。
