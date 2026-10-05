# KEEL：中文入口

Keel 把两件事装进一个 Cindy 插件：**日常随时可问的 Jev**（`jev` 工具，不碰仓库），和 **完整复刻的 pstack 工作流**（推 PR、修 bug、调查、重构……，在固定判断点自动问 Jev）。两组工具分开调用。

- 本机车道表与路径：`ghost_manual({ ghost_id: "keel", path: "keel/profile.md" })`
- pstack 上游镜像与路由表：`ghost_manual({ ghost_id: "keel", path: "pstack/MANUAL.md" })`
- 日常 Jev 用法：`ghost_manual({ ghost_id: "keel", path: "jev/MANUAL.md" })`
- 并行派工协议：`ghost_manual({ ghost_id: "keel", path: "keel/fanout.md" })`

## 工具地图

| 场景 | 工具 | 说明 |
|---|---|---|
| 日常问 Jev | `jev` | 与旧 typesafe-jev `evaluate` 参数完全相同，或简写 `{question, kind, options}` |
| 开始一次 pstack 任务 | `pstack_start` | Jev J1 选 playbook、J2 估深度；返回 run_id、手册路径与步骤 |
| 工作流中的判断点 | `pstack_decide` | 模板 J1–J12，返回 act / reask / minimal / stop |
| 留痕与回看 | `pstack_ledger` | decision / step / evidence / gap |
| 看 PR | `pr_status`、`pr_wait`、`pr_board` | 只读；可合并时只给链接 |
| 改 PR | `pr_open`、`pr_ready`、`pr_reply` | 写 GitHub；需授权来源或弹确认 |
| 评审线程分诊 | `pr_threads` | J4 统一分级 + J5 机器人评论建议 |
| worktree | `worktree` | create / audit / prune（只删干净且已合并） |
| 派工角色 | `roles` | 现读 routing.json |
| 多模型并行 | `fanout_plan`、`fanout_ingest` | arena / interrogate / swarm |

## 用户规则覆盖层（优先于 pstack 上游默认）

1. **统一分级，只修 P0/P1。** P0 紧急严重事故；P1 严重缺陷（可信可达触发路径导致核心流程失效、严重数据错误或安全/隐私越界）；P2 一般缺陷记录不修；P3 改进建议不进修复清单。每个拟修 P0/P1 写清触发条件、错误行为、实际影响与证据；证据不足标“待核实”，不默认降级也不凭猜测升级。
2. **外发须授权。** 推送、开 PR、转 Ready、回帖都需要用户当次授权：`pr_open` / `pr_ready` 要求 `authorization_source`，`pr_reply` 每次弹确认。
3. **永不合并。** Keel 没有任何合并能力；PR 可合并时报告链接，由用户在 GitHub 合并。
4. **按车道走。** `personal`（默认）：非 Draft，到 READY 即停；`gated-handoff`：必需检查全绿才转 Ready，Ready 后交给自动化盯梢，作者停手；`draft-gated-handoff`：在前者基础上强制 Draft，并按 base 分支规则文件校验标题与必需检查。交接后推送/回帖/修复类调用返回 `LANE_HANDED_OFF`。
5. **只改用户点名的仓。** 前序诊断、拆仓建议都不算授权。
6. **worktree 放 `<仓>/.worktrees/`**，不放 `/tmp`。
7. **Orca 派工读 routing.json**（`roles` / `fanout_plan`），Worker 一律 `bypassPermissions`；只按配置里的 fallbacks 降级，配置不可读即停。
8. **多 PR 任务交给现有流水线**：task-priority（汇总任务优先级）→ approve-exec（批准执行）。Keel 不另起编排。
9. **Jev 是判断参考，不是事实证明。** 事实与门禁由确定性代码给出；Jev 只在策略允许的选项里排序。confidence ≥ 0.75 执行（J7 ≥ 0.8）；低于阈值补上下文重问一次，仍低就取改动最小、可撤回的选项；Jev 不可用且判断涉及连带文件时停下回报。
10. **当前提交要有非作者验证。** 车道配了 `verifyCheck`（如 `agent-verify`）时，当前 head 没有该状态通过，`pr_status` 只给 `verify_current_head`，`pr_ready` 返回 `GATE_NOT_MET`。做法：派一个不是作者的模型（`roles` 的 e2e 档，或 `fanout_plan({ kind: "swarm" })`）在当前 head 上跑测试、操作改动的功能、专门找反例；通过后 `gh api repos/<owner>/<repo>/statuses/<sha> -f state=success -f context=agent-verify -f description="<模型> <方法>"`，不通过写 `state=failure` 并修复。有新提交就重验。只改文档或配置时可由作者自查后写状态。建议在仓库分支保护里把该状态设为必需，绕开 Keel 的合并也会被拦住。

## Cursor → Cindy 对照

| pstack（Cursor） | Keel（Cindy） |
|---|---|
| `Task` / subagent | 当前 harness 原生只读 subagent；多模型并行经 `fanout_plan` 开 Orca Worker |
| `~/.cursor/rules/pstack-models.mdc` | `roles` 工具（routing.json） |
| `/loop` | 短等待用 `pr_wait`（心跳轮询 ≤25 分钟）；长周期用 Cindy 定时任务 `schedule_create`（需用户同意） |
| `scripts/watch-pr/watch-pr` | `pr_status` / `pr_wait` |
| `scripts/worktree-audit.sh` | `worktree({op:"audit"})` |
| `show-me-your-work/scripts/log.sh` | `pstack_ledger({op:"log"})` |
| `check-plan.mjs` | `node <keel>/node/check-plan.mjs <plan.md>`（同上游输出与退出码） |
| `orch` CLI（`bun scripts/orch/orch.ts`） | `node <keel>/node/orch.mjs …`（同上游子命令） |
| control-ui / control-cli | Cindy 浏览器 / 桌面工具 |
| cloud agent / Grok Bot | 本机 Orca Worker；自定义入口用 Cindy 插件面板 |
| `gh pr merge` / merge-when-ready | 不提供；用户在 GitHub 合并 |
| poteto-mode 的 `mode: true` 与新任务 reminder | 未移植：Cindy 插件只能改写用户消息正文（气泡会变），不能像 Cursor 那样隐式附加提醒。改为由 agent 在新任务开始时调用 `pstack_start`；用户不想走 pstack 时不调用 |
| watch-pr 的 ChecksUnavailable（无 CI 的仓永不就绪） | 有意替代：本次读取不到任何检查时（真无 CI，或新 head 的检查尚未注册），按冲突、未解决线程、Draft、评审结论判定；读得到检查时与上游一致。刚推送后请等检查出现再看结论 |

## 插件自带的命令行（`<keel>`）

上游由 agent 在终端跑的两个脚本随插件一起安装，`<keel>` 是本机 Keel 安装目录：

```sh
KEEL="$(ls -d "$HOME/Library/Application Support/Cindy/owners/"*/cindy-brain/keel | head -1)"
node "$KEEL/node/check-plan.mjs" <plan.md>     # 计划结构检查，退出码 0 / 1
node "$KEEL/node/orch.mjs" --store <dir> status # orch 记账，子命令同上游
```

多 PR 编排按用户规则交给 task-priority → approve-exec；`orch` 只在用户点名用 pstack 原生编排时使用。

## 一次典型的修 bug

1. `pstack_start({ task: "<用户原话>", repo_dir })` → 得到 `run_id` 与 `pstack/skills/poteto-mode/playbooks/bug-fix.md`。
2. 读 playbook，按步骤复现、写失败测试、修复、证明（J9 证据评分、J12 影响面）。
3. 用户授权后 `pr_open`；`pr_wait` 等 CI；`pr_threads` 分诊；只修 P0/P1；`pr_reply` 回帖（弹确认）。`pr_status` 给出 `verify_current_head` 时按第 10 条验证。
4. `pr_status` 判定 ready → 报告“可合并”与链接；交接车道则 `pr_ready` 后停手。

完成标准：只有 `pr_status` 的 `nextAction` 是 `report_mergeable` / `handoff`，或报出具体阻塞（缺权限、缺环境、预算用完），才算结束；其余情况照 `nextAction` 继续。
