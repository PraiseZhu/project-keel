# KEEL：中文入口

主控协议：聊清需求后调 `keel_run({goal, sc, repo_dir, lead, scope, profile?, pr?, base_ref?})`；会改代码的 run 必须给 scope（可写文件或 glob），缺了直接 SCOPE_REQUIRED；要叠在别的 PR 分支上做就传 base_ref（分支名）。之后只照 `next` 做：`setup` 就 `start_team({worker_permission_mode:"bypassPermissions"})`，`keel_report({phase:"setup", outcome:{worker_permission_mode, team_id}})` 的 team_id 先取 start_team 回执，没有就用主控会话 `get_workspace_info` 的真实结构 `{ok:true, workflow:{workflow_id, lead_session_id, status}, workers}` 里的 `workflow.workflow_id`（主控还可取 `workflow.lead_session_id`）；`workflow` 为 null（worker 会话）则 human:setup。`dispatch` 带 `create_worker` 就原样传入并立刻报 accepted；带 `subagent` 就用自带 subagent 跑一次，不开 Worker、不报 accepted，完成后直接 final（见「subagent 派工」）。`reconcile` / `verify_stopped` 时主控在调用 `list_workers` 的同一时刻再调 `get_workspace_info`，把 `workflow.workflow_id` 作为 team_id 附进结果，不要抄 run 状态里记着的值。start_team 回执、setup、对账必须用同一种 ID。worker 回报后 `keel_report({phase:"final"})`；调查类节点的 worker 只在最后回复里交 NodeReport JSON，主控把它原样作 `inline_report` 传进去。只有 `next.kind=done` 才算完成；KEEL 永不合并。`decide` 时自己裁决，拿不准才问用户。pstack 手册是深读材料。

`dispatch` 若带 `subagents`，必须按「subagent 派工」同批并行启动，收齐 `parallel_reports` 后回报父 `dispatch_key`；不能只处理第一项，也不能改走旧 `fanout` 入口。

- 本机车道表与路径：`ghost_manual({ ghost_id: "keel", path: "keel/profile.md" })`
- pstack 上游镜像与路由表：`ghost_manual({ ghost_id: "keel", path: "pstack/MANUAL.md" })`
- 日常 Jev 用法：`ghost_manual({ ghost_id: "keel", path: "jev/MANUAL.md" })`
- 并行派工协议：`ghost_manual({ ghost_id: "keel", path: "keel/fanout.md" })`

## 工具地图

| 场景 | 工具 | 说明 |
|---|---|---|
| 日常问 Jev | `jev` | 与旧 typesafe-jev `evaluate` 参数完全相同，或简写 `{question, kind, options}` |
| 开一次图运行 | `keel_run` | 聊清需求后调用，必须带 `lead`（codex / claude-code / pi）；返回 `{run_id, profile, next}`，之后只照 next 做 |
| 交回节点结果 | `keel_report` | `setup` / `accepted` / `reconcile` / `recover` / `final`；`progress` 只记录真实子步骤 |
| 阻塞等待 | `keel_wait` | CI / 插件任务 / 在途节点，最长 15 分钟 |
| 回答方向门 | `keel_gate` | `run_id` + `gate_id` + `answer`；done 门选 `waive` 时还要 `authorization_source` |
| 看 run 状态 | `keel_status` | 不推进图 |
| 开始一次 pstack 任务 | `pstack_start` | 迁移入口：必须带 `lead`；`task` 映射为 `goal`，必须传 `repo_dir` |
| 工作流中的判断点 | `pstack_decide` | 模板 J1–J12，返回 act / reask / minimal / stop |
| 留痕与回看 | `pstack_decide`（op=log / read） | decision / step / evidence / gap |
| 看 PR | `pr_status`（board:true 出看板）、`pr_wait` | 只读；可合并时只给链接 |
| 改 PR | `pr_open`、`pr_ready`、`pr_reply` | 写 GitHub；`pr_open` / `pr_ready` 需授权来源，`pr_reply` 默认直接发。当前分支已有打开的 PR 时 `pr_open` 只推送并复用（`reused:true`），不再 `gh pr create`。开 PR 的 title / sections 会去掉本机绝对路径 |
| 评审线程分诊 | `pr_threads` | J4 统一分级 + J5 机器人评论建议 |
| worktree | `worktree` | create / audit / prune（只删干净且已合并） |
| 派工角色 | `fanout`（op=roles） | 现读 routing.json |
| 多模型并行 | `fanout`（op=plan / ingest） | arena / interrogate / swarm |

## 用户规则覆盖层（优先于 pstack 上游默认）

1. **统一分级，只修 P0/P1/P2。** P0 紧急严重事故；P1 严重缺陷（可信可达触发路径导致核心流程失效、严重数据错误或安全/隐私越界）；P2 真实、影响局部的一般缺陷，纳入修复；P3 改进建议不进修复清单。每个拟修 P0/P1/P2 写清触发条件、错误行为、实际影响与证据；证据不足标“待核实”，不默认降级也不凭猜测升级。
2. **外发须授权。** 推送、开 PR、转 Ready 需要用户当次授权：`pr_open` / `pr_ready` 要求 `authorization_source`。`pr_reply` 默认直接发表（用户在设置页选“每条确认”时才弹框）；只回分级说明、反证或已修复说明。
3. **永不合并。** Keel 没有任何合并能力；PR 可合并时报告链接，由用户在 GitHub 合并。
4. **按车道走。** `personal`（默认）：非 Draft，到 READY 即停；`gated-handoff`：必需检查全绿才转 Ready，Ready 后交给自动化盯梢，作者停手；`draft-gated-handoff`：在前者基础上强制 Draft，并按 base 分支规则文件校验标题与必需检查。交接后推送/回帖/修复类调用返回 `LANE_HANDED_OFF`。
5. **只改用户点名的仓。** 前序诊断、拆仓建议都不算授权。
6. **worktree 放 `<仓>/.worktrees/`**，不放 `/tmp`。
7. **Orca 派工读 routing.json**（`fanout({ op: "roles" | "plan" })`），Worker 一律 `bypassPermissions`；只按配置里的 fallbacks 降级，配置不可读即停。
8. **多 PR 任务交给现有流水线**：task-priority（汇总任务优先级）→ approve-exec（批准执行）。Keel 不另起编排。
9. **Jev 是判断参考，不是事实证明。** 事实与门禁由确定性代码给出；Jev 只在策略允许的选项里排序。confidence ≥ 0.75 执行（J7 ≥ 0.8）；低于阈值补上下文重问一次，仍低就取改动最小、可撤回的选项；Jev 不可用且判断涉及连带文件时停下回报。
10. **当前提交要有非作者验证。** 车道配了 `verifyCheck`（如 `agent-verify`）时，当前 head 没有该状态通过，`pr_status` 只给 `verify_current_head`，`pr_ready` 返回 `GATE_NOT_MET`。作者：派一个不是作者的模型（`fanout({ op: "roles" })` 的 e2e 档，或 `fanout({ op: "plan", kind: "swarm" })`）验证当前 head，自己不写这个状态。验证者：在自己的会话里跑测试、操作改动的功能、专门找反例；通过后执行 `gh api repos/<owner>/<repo>/statuses/<sha> -f state=success -f "context=<verifyCheck>" -f "description=<模型> <方法>"`，不通过写 `state=failure` 并说明原因。有新提交就重验。只改文档或配置时可由作者自查后写状态。验证者报告的 `ran` 必须列测试运行器本身的命令（如 `npm test`、`npx vitest run`、`pytest`）；`npm run verify` 这类聚合脚本 KEEL 认不出测试，会把级别判成 `type-check-only`。done 门遇到级别低于 SC 要求且 head/patch 都一致时给 `retry_verify`/`stop`，选 `retry_verify` 后重新派非作者验证，不再只给 wait/stop 卡死。信任边界：Keel 不核验状态由谁写入；本机所有 agent 共用同一个 GitHub 账号，这道门防疏忽、不防蓄意伪造，靠用户抽查兜底。要真正隔离，需给验证者独立的 GitHub 身份。建议在仓库分支保护里把该状态设为必需，绕开 Keel 的合并也会被拦住。

交接车道可配置 `handoffHelperPath`，指向已部署的 Vigil `mivo-handoff.mjs` 绝对路径（需支持 `inspect` 和 `handoff --expected-head`）。本机需安装可从 PATH 或常见安装位置找到的 Node CLI；Cindy 内置 Node worker 不替代该外部执行器。配置后，`pr_ready` 在当前 HEAD 的 CI、审查进场和作者身份核对通过后转 Ready，自动发布并读回作者交接回执，最后才写本地交接记录；`dry_run` 不发布。读取失败或 HEAD 漂移时不声称交接成功。重复调用复用同代次回执，转 Draft 或进入新 Ready 代次后，过期本地记录不再锁住作者。外部有效回执也会拦住丢失本地记录的作者会话。未配置的车道保留原有本地交接行为。

## Cursor → Cindy 对照

| pstack（Cursor） | Keel（Cindy） |
|---|---|
| `Task` / subagent | 只读一次性节点走 `next.subagent` 或同批 `next.subagents`，不能因模型不匹配改用 Worker；持续负责人走已授权 Worker |
| `~/.cursor/rules/pstack-models.mdc` | 模型配置页的 `/kv.manual` 驱动 keel_run；旧独立 `fanout({op:"roles"})` 只读全局 routing.json，不代表此页设置 |
| `/loop` | 短等待用 `pr_wait`（心跳轮询 ≤25 分钟）；长周期用 Cindy 定时任务 `schedule_create`（需用户同意） |
| `scripts/watch-pr/watch-pr` | `pr_status` / `pr_wait` |
| `scripts/worktree-audit.sh` | `worktree({op:"audit"})` |
| `show-me-your-work/scripts/log.sh` | `pstack_decide({op:"log"})` |
| `check-plan.mjs` | `node <keel>/node/check-plan.mjs <plan.md>`（同上游输出与退出码） |
| `orch` CLI（`bun scripts/orch/orch.ts`） | `node <keel>/node/orch.mjs …`（同上游子命令） |
| control-ui / control-cli | Cindy 浏览器 / 桌面工具 |
| cloud agent / Grok Bot | 本机 Orca Worker；自定义入口用 Cindy 插件面板 |
| `gh pr merge` / merge-when-ready | 不提供；用户在 GitHub 合并 |
| poteto-mode 的 `mode: true` 与新任务 reminder | 未移植：Cindy 插件只能改写用户消息正文（气泡会变），不能像 Cursor 那样隐式附加提醒。改为由 agent 在新任务开始时调用 `keel_run`；用户不想走 KEEL 时不调用 |
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

流程是三段：写手 → 开 PR、等 CI → 非作者审查。

1. `keel_run({ goal: "<用户原话>", sc, repo_dir, lead, scope, playbook: "bug-fix" })`。`playbook` 写明任务类型（bug-fix / feature / refactoring / investigation），KEEL 就不再猜；`sc` 尽量每条带 `verify` 命令。
2. 写手（`implement`）一个会话做完：先提交失败测试，再提交修复，跑测试。新功能先由 `architect-plan` 出方案，写手按方案做；重构先提交钉住行为的测试。
3. `open-pr` → `wait-ci`：主控照 next 调 `pr_open`（用户授权原话填 `authorization_source`）再 `keel_wait`。CI 红走 `fix-ci`，有评审线程走 `triage-threads`，二者都先经 `pr_open` 推送再等 CI。
4. 审查（`astra-final-review`）：不同家族的强模型只读审 diff、亲自跑测试并给出 verdict。`FAIL` 由 `g-accept` 退回写手，写手的任务说明会列出审查报告；`PASS` / `PASS+NOTES` 进入 `report-ready`。同一失败重复两次时 `astra-unstick` 先出主意。
5. done 门发现某条 SC 没有证据时给 `revise` / `waive` / `stop`：`revise` 退回写手并写明缺哪条；`waive` 必须带用户原话 `authorization_source`。验证级别不够时给 `retry_verify`，重派审查。
6. `pr_status` 判定 ready → 报告“可合并”与链接；交接车道则 `pr_ready` 后停手。

完成标准：只有 `pr_status` 的 `nextAction` 是 `report_mergeable`，或交接车道 `pr_ready` 成功后变为 `stopped_after_handoff`，或报出具体阻塞（缺权限、缺环境、预算用完），才算结束；看到 `handoff` 表示该调 `pr_ready` 交接，不是结束；其余情况照 `nextAction` 继续。

## 看板与真实步骤

### Vigil 现有任务进度

个人构建配置可用 `vigilHomes` 指定 Vigil 运行目录（绝对路径数组，默认不读取任何目录）。重建并安装插件后，看板只读这些目录中的任务绑定、活动时间、处理结果和验证回执，不重新派单或启动图工作流。绑定按仓库、PR、任务、会话和提交核对；验证回执另外核对摘要。

任务卡片显示有真实记录的当前状态；详情包含原 Cindy 修复会话入口、活动/结果/验证文件位置，以及 Keel 台账最近的步骤和证据。它不是完整执行轨迹的替代：代码编辑与独立审查没有结构化活动时不猜子步骤，不从聊天推断。旧阻塞记录后的新验证活动可恢复为验证中；新阻塞结果优先于旧活动。过期活动、未来时间、重复来源、提交变化及读取失败均标为待确认。看板读取不会延长任务心跳，也不会授予写代码、推送或合并权限。

### Keel 自身工作流

面板和主视图只读展示三列：本地工作流 → 云端检查至全绿 → 已交接。`pr_status({board:true, scope:"open"|"all", refresh?:true})` 按当前 GitHub 账号跨仓分页；`complete:false` 或 `more:true` 说明尚未读完，按返回的重试时间继续调用。旧 `boardRepos` 不再缩小全局看板范围；`repos` 只筛选本次工具返回的 `rows`，不影响全局读取、`total` 或面板。界面的仓库筛选在本地进行。

本人在其它电脑创建的 PR 从 GitHub 统一读取；本机 Keel 索引还补充处理过的非本人作者 PR。其它电脑未共享的非本人 PR 关联与私有运行步骤不能凭空取得。未关联流程显示「步骤 ?」。Mini 内部盯梢未接入，只在已有有效交接记录时标「已交接」，不推断已可合并。

执行中如需显示本地步骤，由绑定的主控在实际进入该步骤时调用：

```json
{"run_id":"<本次run>","phase":"progress","dispatch_key":"<当前在途派工key>","step":4}
```

这是 `keel_report` 的只记账分支：不推进图、不派工、不代替 `final`，不要为了让灯亮定时假报。编号必须来自当前节点的 `playbook_steps`（从1开始）；feature/refactoring 共8步，bug-fix 共6步。没有真实步骤回报时保留未知位置，不从聊天推断。错误会话、旧派工 key、已结束节点和超范围步骤都拒绝。

PR 状态每30秒读取（面板可见时）；本地回报立即更新卡片。API失败、配额不足、部分不可读分别显示错误并保留已读卡片。不要把 GitHub 的 `updatedAt` 或刷新时间当作任务心跳，也不要把 `done` 当成 PR 已合并。查询详情继续使用原车道门禁判定，不执行写操作。

## 派工：查资料用 sub，其余开 Worker

原则：一次性任务用主控自带的原生 sub，长任务开 Worker。四个环节固定如下：

| 环节 | 图节点 | 怎么派 | 模型 |
|---|---|---|---|
| 查资料 | explorer / researcher | 主控自带原生 sub，一次并行 3 个，每个只查一个角度 | 不可配置：Claude Code 主控填 `model=haiku`（主控不是 Claude 模型时不填）；Codex 主控填同网关的 `gpt-6-luna`（不可用时不填） |
| 想方案 | architect-plan、astra-unstick、方向裁决 | 1 个 Worker，主控自己先出一版 | 说明书 architect，必须是和主控不同的执行框架 |
| 写代码 | 写入节点 | 1 个 Worker | 说明书 worker（主选 + 同框架备用） |
| 做检查 | astra-final-review | 1 个 Worker | 说明书 final_review_route（+ final_review_fallbacks），必须和写代码不同执行框架、不同模型族；运行时会跳过与写手同框架的路线 |

查资料的 `next.subagents` 是一批并行成员，不是故障备选。主控在同一批全部启动（Codex code-mode 可用 `Promise.all`），自身推进不重叠工作，收齐后关闭这些 sub。Codex 同一会话最多同时开 6 个子助手，跑完不关也占名额。每个成员的 `dispatch_key`、原生 id、报告路径各自独立；必须收齐所有报告才能进入下一步，任何失败或缺证据不得冒充全体通过。Pi 主控没有可用的查资料子助手，会停在人工门。

原生 sub 不报 accepted。收齐后用父 dispatch_key 回 `keel_report({phase:"final",dispatch_key,parallel_reports:[{dispatch_key,native_agent_id,execution_route,report}]})`；report 为完整 NodeReport，成员 native_agent_id 不能重复。查资料的 `execution_route` 只核对执行框架（agent）与主控一致，模型、网关、推理强度跟主控走，照实填写，不能编造。工具会核对完整性、身份、HEAD 和结论，不会把 FAIL 成员吞掉。宿主不能提供可核实身份时按 blocked 回报。超时先停止原生 sub，再答 retry/stop；重试仍保持原生通道，不改开 Worker。

想方案、写代码、做检查都需要先 `start_team`，再按 `next.create_worker` 原样开 Worker。主路线报不可用时按该环节的备用顺序降级并写明原因，用尽即停，不自找替代。

模型配置使用 `/kv.manual` 唯一真源，设置页只编辑两套方案（我用 Claude Code 时 / 我用 Codex 时），只给能跑通的选项：不出现 Pi，不出现 Claude Code + Art Cindy 的 GPT（网关 403）。按任务类型分列的旧配置不再生效，统一读默认列。每次派工重读，运行中已派出的节点不偷偷换模型。显式 profile 必须与当前 lead 框架一致；说明书里的 lead 路线只是参考，不会切换当前聊天模型。program 也读取该 lead 的默认方案。旧独立 `fanout({op:"roles"|"plan"})` 仍是全局 routing.json 的显式入口，不能当成模型配置页的执行器。

插件任务（旧通道）走内部 `cindy.tasks`：`getRun` 只传 `runId`；`revision` / `expectedRevision` 必须是安全整数；create 回执丢失用 `list` 按 `requestKey` 找回，找不到开人工门，禁止重放 create；任务 running 时 `keel_wait` 内部 `getRun` 轮询，completed 后 `readMessages` 当 final。当前图不再引用该通道。
