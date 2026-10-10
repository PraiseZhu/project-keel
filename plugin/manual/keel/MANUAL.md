# KEEL：中文入口

主控协议：聊清需求后调 `keel_run({goal, sc, repo_dir, lead, scope, profile?, pr?, base_ref?})`；会改代码的 run 必须给 scope（可写文件或 glob），缺了直接 SCOPE_REQUIRED；要叠在别的 PR 分支上做就传 base_ref（分支名）。之后只照 `next` 做：`setup` 就 `start_team({worker_permission_mode:"bypassPermissions"})`，`keel_report({phase:"setup", outcome:{worker_permission_mode, team_id}})` 的 team_id 先取 start_team 回执，没有就用主控会话 `get_workspace_info` 的真实结构 `{ok:true, workflow:{workflow_id, lead_session_id, status}, workers}` 里的 `workflow.workflow_id`（主控还可取 `workflow.lead_session_id`）；`workflow` 为 null（worker 会话）则 human:setup。`dispatch` 带 `create_worker` 就原样传入并立刻报 accepted；带 `subagent` 就用自带 subagent 跑一次，不开 Worker、不报 accepted，完成后直接 final（见「subagent 派工」）。`reconcile` / `verify_stopped` 时主控在调用 `list_workers` 的同一时刻再调 `get_workspace_info`，把 `workflow.workflow_id` 作为 team_id 附进结果，不要抄 run 状态里记着的值。start_team 回执、setup、对账必须用同一种 ID。worker 回报后 `keel_report({phase:"final"})`；调查类节点的 worker 只在最后回复里交 NodeReport JSON，主控把它原样作 `inline_report` 传进去。只有 `next.kind=done` 才算完成；KEEL 永不合并。`decide` 时自己裁决，拿不准才问用户。pstack 手册是深读材料。

- 本机车道表与路径：`ghost_manual({ ghost_id: "keel", path: "keel/profile.md" })`
- pstack 上游镜像与路由表：`ghost_manual({ ghost_id: "keel", path: "pstack/MANUAL.md" })`
- 日常 Jev 用法：`ghost_manual({ ghost_id: "keel", path: "jev/MANUAL.md" })`
- 并行派工协议：`ghost_manual({ ghost_id: "keel", path: "keel/fanout.md" })`

## 工具地图

| 场景 | 工具 | 说明 |
|---|---|---|
| 日常问 Jev | `jev` | 与旧 typesafe-jev `evaluate` 参数完全相同，或简写 `{question, kind, options}` |
| 开一次图运行 | `keel_run` | 聊清需求后调用；返回 `{run_id, profile, next}`，之后只照 next 做 |
| 交回节点结果 | `keel_report` | `setup` / `accepted` / `reconcile` / `recover` / `final` |
| 阻塞等待 | `keel_wait` | CI / 插件任务 / 在途节点，最长 15 分钟 |
| 回答方向门 | `keel_gate` | `run_id` + `gate_id` + `answer`；done 门选 `waive` 时还要 `authorization_source` |
| 看 run 状态 | `keel_status` | 不推进图 |
| 开始一次 pstack 任务 | `pstack_start` | 迁移入口：`task` 映射为 `goal`，必须传 `repo_dir` |
| 工作流中的判断点 | `pstack_decide` | 模板 J1–J12，返回 act / reask / minimal / stop |
| 留痕与回看 | `pstack_decide`（op=log / read） | decision / step / evidence / gap |
| 看 PR | `pr_status`（board:true 出看板）、`pr_wait` | 只读；可合并时只给链接 |
| 改 PR | `pr_open`、`pr_ready`、`pr_reply` | 写 GitHub；`pr_open` / `pr_ready` 需授权来源，`pr_reply` 默认直接发。当前分支已有打开的 PR 时 `pr_open` 只推送并复用（`reused:true`），不再 `gh pr create`。开 PR 的 title / sections 会去掉本机绝对路径 |
| 评审线程分诊 | `pr_threads` | J4 统一分级 + J5 机器人评论建议 |
| worktree | `worktree` | create / audit / prune（只删干净且已合并） |
| 派工角色 | `fanout`（op=roles） | 现读 routing.json |
| 多模型并行 | `fanout`（op=plan / ingest） | arena / interrogate / swarm |

## 用户规则覆盖层（优先于 pstack 上游默认）

1. **统一分级，只修 P0/P1。** P0 紧急严重事故；P1 严重缺陷（可信可达触发路径导致核心流程失效、严重数据错误或安全/隐私越界）；P2 一般缺陷记录不修；P3 改进建议不进修复清单。每个拟修 P0/P1 写清触发条件、错误行为、实际影响与证据；证据不足标“待核实”，不默认降级也不凭猜测升级。
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
| `Task` / subagent | KEEL 判定的只读一次性节点由主控自带 subagent 跑（`next.subagent`）；多模型并行经 `fanout` 开 Orca Worker |
| `~/.cursor/rules/pstack-models.mdc` | `fanout({ op: "roles" })`（routing.json） |
| `/loop` | 短等待用 `pr_wait`（心跳轮询 ≤25 分钟）；长周期用 Cindy 定时任务 `schedule_create`（需用户同意） |
| `scripts/watch-pr/watch-pr` | `pr_status` / `pr_wait` |
| `scripts/worktree-audit.sh` | `worktree({op:"audit"})` |
| `show-me-your-work/scripts/log.sh` | `pstack_decide({op:"log"})` |
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
3. 用户授权后 `pr_open`；`pr_wait` 等 CI；`pr_threads` 分诊；只修 P0/P1；`pr_reply` 回帖。`pr_status` 给出 `verify_current_head` 时按第 10 条验证。终审报告 `verdict=FAIL` 时图从 `g-accept` 直接退回写代码节点（不问 Jev；报告 status=failed/blocked 同样适用，且下一轮不能跳过终审）；PASS / PASS+NOTES 才进 verify-head。写代码节点成功后走 `open-pr`：`fix-ci` 与 `triage-threads` 都先由 `pr_open` 推送并复用已有 PR，再 `wait-ci`（只提交不推送会等到旧提交）。本地验证按工作树 HEAD 比对 `head_sha`，未推送的修复也能过 G-advance。写代码节点被退回进入（终审 revise、CI 红、评审线程）时，即使该节点是第 1 次派工，brief 也会列出本 run 前序节点的 `.keel/` 报告路径并要求先读；清单只列真实写报告的节点，不含 `open-pr` / `wait-ci` 等工具节点。done 门发现某条 SC 没有证据时给 `revise` / `waive` / `stop`：`revise` 退回该图 `g-accept` 的 revise 目标并在 brief 写明缺哪条 SC；`waive` 必须带用户原话 `authorization_source`，KEEL 记入 decisions 并把该 SC 标为豁免，其余门禁仍须满足才算 done。
4. `pr_status` 判定 ready → 报告“可合并”与链接；交接车道则 `pr_ready` 后停手。

完成标准：只有 `pr_status` 的 `nextAction` 是 `report_mergeable`，或交接车道 `pr_ready` 成功后变为 `stopped_after_handoff`，或报出具体阻塞（缺权限、缺环境、预算用完），才算结束；看到 `handoff` 表示该调 `pr_ready` 交接，不是结束；其余情况照 `nextAction` 继续。

## subagent 派工

KEEL 判定只读、非终审/复核/验证/质询、且路由 agent 等于主控 harness 的一次性节点走 `next.subagent`，主控不自选。Claude Code 用 Agent 工具：`subagent_type` 用 `keel-node`（不要用 general-purpose），`model` 显式传 `next.subagent.model`（只允许 haiku / sonnet 别名；opus、fable 等其它 Claude 模型走 Orca），prompt 为 `task`，前台运行；不能设 effort。实际跑的是主控环境的该别名，不是路由里的 provider。Codex 用自带子代理，任务内容为 `task`，不传模型（只有路由模型等于主控模型才走这条）。pi 一律 Orca。完成后有 `report_path` 就 `keel_report({phase:"final", dispatch_key})`，没有就把最后回复的 NodeReport 原样作 `inline_report`。禁止开 Orca worker、禁止报 accepted、禁止伪造 worker 回执，同一 dispatch_key 只派一次。subagent 失败（工具报错、拿不到报告）时照实 `phase=final` 交 `status=failed`；同一节点下一次 attempt 改走 Orca `create_worker`。超时会出 `human:<节点>` 门，先停掉 subagent 再选 retry/stop。

插件任务（旧通道）走内部 `cindy.tasks`：`getRun` 只传 `runId`；`revision` / `expectedRevision` 必须是安全整数；create 回执丢失用 `list` 按 `requestKey` 找回，找不到开人工门，禁止重放 create；任务 running 时 `keel_wait` 内部 `getRun` 轮询，completed 后 `readMessages` 当 final。当前图不再引用该通道。
