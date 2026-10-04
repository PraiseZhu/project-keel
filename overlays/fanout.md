**Keel 改写（优先于下文上游内容）**

并行车道由 `fanout_plan` 规划：模型现读 routing.json（不同家族的 review / execute / 另一审核变体档；`lead_agent` 决定审核档读不读 `review.when_lead.<agent>`），写车道 worktree 预建在 `<仓>/.worktrees/pstack-<fanout_id>-<label>/`。主 Agent 先 `start_team({worker_permission_mode:"bypassPermissions"})`，再分两段派发：先派 `create_workers.workers`，候选 / 切片全部回报后再派 `after_stage1` 里的交叉评审 / 验证车道；派发说明标注 `(model/effort)`。结果交给 `fanout_ingest` 汇收（arena 用 Jev J3 选基础，interrogate 用 J4 统一分级）。只按 routing.json 预授权的 fallbacks 降级，配置不可读即 fail-closed。没有 Orca 时只能用原生 subagent 降级，并明确标注“同模型，非多模型”。

---
