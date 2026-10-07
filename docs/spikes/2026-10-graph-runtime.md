# KEEL Graph Runtime 阶段 0 实测

已完成 P0-1、P0-3、P0-4、P0-5、P0-9 的运行时验证，P0-7 与 P0-8 由 lead 补充观察。P0-2、P0-6 需要用户在场；P0-10 因 Host 要求授权插件协调器 Auto 而阻塞。测试插件源码与包保留在忽略目录；`keel-spike` v1.0.5 仍安装，待用户在 Cindy 中卸载（当前工具面没有卸载接口）。

| P0-<n> | 状态 | 结论一句 | 原始证据（工具返回原文片段、时间戳） |
|---|---|---|---|
| P0-1 | PASS | Codex tool-call 含 `args.session_context`，其中有四个宿主上下文字段。 | 2026-10-07 19:41 CST：`messageFields=[args,callId,tool,type]`；`sessionContextFields=[session_id,workdir,workdir_is_local,workdir_is_read_only]`。 |
| P0-2 | PENDING | 由 lead 在 Codex 与 Claude Code 会话完成卡片关联和后台续跑测试。 | 本执行者派工边界明确排除此项；未调用。 |
| P0-3 | PASS | `isolatedWorkspace` 使用独立 cwd，但任务仍可读和进入 Project Anvil。 | 2026-10-07 19:42:41 CST：`status=completed`；任务回报 `exists-dir`、`readable`、`searchable`，无权限确认。 |
| P0-4 | PASS | 三个任务并发创建均成功；`readMessages` 页游标前进，`limit:101` 被拒。 | 2026-10-07 19:47:05 CST：三次 `create` 均为 `ok:true`、`permissionMode=ask`；19:46 CST `maxPageSize=100`，101 返回 `UNKNOWN / Invalid task request`。 |
| P0-5 | PASS | 常驻 Node 时钟连续两小时每 15 秒通知一次，到达率 99.8%。 | 2026-10-07 22:01:43 CST lead 读取：`startedAt=2026-10-07T12:00:26.576Z`、`count=484`、`expectedTicks=485`、`arrivalRate=0.998`、`lastAt=2026-10-07T14:01:27.499Z`。 |
| P0-6 | PENDING | 由 lead/user 在场时测试 mainView 消息与刷新延迟。 | 本执行者派工边界明确排除此项；未调用。 |
| P0-7 | PARTIAL | Claude Code 主控侧多次派 Astra / grok worker，创建、排队、回报均正常；Codex 主控侧待用户在场开 Sol 会话复测。 | 见下方“P0-7 主控侧观察”（回执与查询字段原样记录）。 |
| P0-8 | PARTIAL | Claude Code 项目级 Stop 钩子在 Cindy 会话中触发且拦截有效；Codex 钩子未触发，待用户在场复测（可能需重启或信任）。 | 2026-10-07 19:23:30 CST 收到 Stop（stop_hook_active=false）→ block → 19:23:49 第二次 Stop（stop_hook_active=true）→ 放行。 |
| P0-9 | PASS | Codex 与 Claude Code 返回的 `identityFields` 均为空，没有 agent/model 字段。 | 2026-10-07 19:41 CST：Codex `identityFields=[]`；lead 提供的 Claude Code 结果（时间未提供）也为 `identityFields=[]`。 |
| P0-10 | BLOCKED_NEEDS_USER | 指定路线任务运行完成，但 `start_team` 未启动 team，Host 要求授权插件协调器 Auto。 | 2026-10-07 19:57:54 CST：`errorCode=INTERNAL`，hint 为 `Authorize Auto for the plugin coordinator before creating Workers`。 |

## 逐项记录

### P0-1 会话上下文

`spike_ctx` 在 Codex 会话返回 `messageFields=[args,callId,tool,type]`、`argumentFields=[session_context]` 和 `sessionContextFields=[session_id,workdir,workdir_is_local,workdir_is_read_only]`。上下文值为当前 Project Keel worktree、`workdir_is_local=true`、`workdir_is_read_only=false`；session id 未写入报告。lead 提供的 Claude Code 结果有相同字段，`workdir` 指向 Project Keel，两个布尔值分别为 true/false。

### P0-2 叫醒主控

本批不负责。待 lead 在 Codex 与 Claude Code 主控会话中各测试一次，并记录卡片关联、后台续跑后的 `did-turn-end` 与重启后的关联状态。

### P0-3 隔离工作区

`tasks.create({ isolatedWorkspace:true })` 返回工作目录 ``~/Library/Application Support/Cindy/owners/<owner>/dialogues/2026-10-07/<taskId>``，`permissionMode=ask`。任务完成后报告 cwd 与该目录一致，并对 `测试仓 Project Anvil 的绝对路径` 检查到 `exists-dir`、`readable`、`searchable`。没有弹出权限确认。结果表明 isolated workspace 改变了 cwd，但没有隐藏或阻止对该绝对路径的只读访问。

### P0-4 任务并发

一次 `spike_create_three` 同时创建三个任务，三项均 `ok:true`，均为 `permissionMode=ask`，没有拒绝或错误码。任务没有发送输入。

`tasks.capabilities()` 返回 `maxPageSize=100`。`readMessages({limit:100})` 返回 `pageFields=[items,nextCursor]` 和 4 条记录。`limit:1` 返回一条记录与 `nextCursor`；将该游标作为 `after` 后，下一页返回不同记录及新游标。`limit:101` 返回 `{code:"UNKNOWN", message:"Invalid task request"}`。回读器最初按 `messages` 字段取值，随后更新为保留原始 `items`；报告依据是原始页内容。

### P0-5 常驻时钟

resident Node worker 每 15 秒发送一次 JSON-RPC `clock.tick` notification，`main.js` 将当前 Node 进程代际的计数及首末时间写入插件 `/kv`。稳定窗口从 v1.0.5 Node `startedAt=2026-10-07T12:00:26.576Z`（20:00:26.576 CST）起算。22:01:43 CST lead 读取：`count=484`，`expectedTicks=485`，`arrivalRate=0.998`，首末通知 20:00:41.579 与 22:01:27.499 CST（`totalCount=560` 含此前调试代际，不计入）。结论：在本机 Cindy 中，常驻 Node 进程两小时内持续运行、没有被回收，时钟通知只差 1 次（读取时刻落在两次通知之间）。

### P0-6 主视图

本批不负责，待 lead/user 完成实测。

### P0-7 主控侧观察（lead，Claude Code 主控）

- `create_worker` / `create_workers` 回执字段：`worker_id`、`worker_session_id`、`role`、`agent`、`label`、顶层 `dispatched`（为 false）、`dispatch_outcome{kind, source, dispatched:true, wakeKind:"queued"}`、`queued_message_id`、`limit`；不回显 model / provider / effort。
- `list_workers` 返回 workerId、sessionId、role、agent、model、effort、label、status、idleSince；不返回 provider，也没有 `complete` 字段。
- `get_workspace_info`（主控会话）返回 `{ok, workflow:{workflow_id, lead_session_id, status}, ui_capacity, worker_count, workers:[…]}`；worker 会话中调用时 `workflow` 为 null。workers 项不含 team / workflow 字段。
- 被 `idle_worker` 的 worker 之后 `archive_worker` 返回 WORKER_NOT_FOUND，`list_workers` 也查不到。
- Codex 主控侧尚未测试。

### P0-8 Stop 钩子

Claude Code：在 Project Anvil 写入项目级 `.claude/settings.local.json` Stop 钩子（测完已删除），探针 worker 结束时钩子收到输入字段 session_id、transcript_path、cwd、prompt_id、permission_mode、effort、hook_event_name、stop_hook_active、last_assistant_message、background_tasks、session_crons（没有 model）；返回 `{decision:"block", reason}` 后会话继续一轮，第二次 Stop 带 `stop_hook_active=true`，放行。

Codex（0.159.2）：写入 Cindy 的 Codex hooks.json 后探针 worker 正常结束，但钩子没有任何调用记录（测完已删除）。推断原因：Codex 只在启动时读取钩子，或未信任的钩子默认不运行（`hooks.state.trusted_hash`），未证实。需用户在场：写回测试钩子 → 重启 Cindy → 观察是否提示信任。

### P0-9 主控身份

Codex 返回 `identityFields=[]`。Claude Code lead 提供的返回同样是空数组。两个会话的 tool-call 与 `session_context` 都没有 agent/model 字段；主控身份不能由本插件自动识别，应由调用方提供 `lead/profile`。

### 补充：插件任务能力清单

`tasks.capabilities()` 的 operations 为 capabilities、models、setModel、requestWriteAccess、startTeam、getTeam、setTeamPlan、releaseWorker、create、list、get、send、getRun、listRuns、cancel、readMessages；targets 为 `own-plugin-local-session`；`maxPageSize=100`；`exactRoute=true`；`sourceCallContext=true`。其中 startTeam / getTeam / setTeamPlan / releaseWorker 表明插件侧有团队控制接口，可作为后续 P0-10 的替代路径评估。

### P0-10 插件任务当主控

`tasks.models()` 用内部 agent 标识 `cc` 表示 `claude-code`；目录中有 `art-cindy / grok-4.6`，其 `efforts` 包含 `high`。初次路线预检未识别 `cc` 别名并提前返回，没有创建任务；修正解析后只调用一次实际 `tasks.create`。实际 route 为 `{agentKind:"cc",providerId:"art-cindy",model:"grok-4.6",effort:"high",fastMode:false}`，任务权限为 `ask`。任务调用 `start_team({worker_permission_mode:"bypassPermissions"})` 后收到 `{ok:false,errorCode:"INTERNAL",data:{hint:"Authorize Auto for the plugin coordinator before creating Workers"}}`，最终状态为 `completed` 并报告 `BLOCKED_NEEDS_USER`。Orca team 没有启动，没有创建 worker，也没有路径可见性答案。用户需在 Cindy 授权插件协调器 Auto；本批不重试。

## 阻塞与清理

- lead 报告先安装了 v1.0.0。本执行者随后将 `keel-spike` 更新至 v1.0.1～v1.0.5；每次 `ghost_forge_install` 均返回 `updated`、`enabled:true`，未安装或更新正式 `keel`。
- P0-3 与 P0-10 的输入最终均为 `completed`，清理读取确认没有未结束输入。P0-4 创建的三条任务没有发送输入，因此没有运行可取消；当前 tasks API 操作列表不含删除任务操作。
- P0-10 首次清理请求 `cancel({taskId,runId})` 返回 `UNKNOWN / Invalid task request`。之后任务完成，最终清理读取见 `status=completed`，无需再取消。
- 没有创建 Orca worker，所以没有 worker 可归档。P0-10 最终没有活跃团队。
- P0-5 已于 22:01:43 CST 读取。`spike_cleanup` 确认两条测试任务均为 completed，无需取消。`keel-spike` 仍安装：当前工具面没有插件卸载接口，需用户在 Cindy 的插件页卸载。正式 `keel` 插件未安装或更新。
- 本批唯一需要用户处理的阻塞是 P0-10：在 Cindy 授权插件协调器 Auto。该授权后是否重跑由 lead 决定；本批不重试。

## 本地验证

- `node --check main.js`：通过。
- `node --check node/worker.cjs`：通过。
- `node -e "JSON.parse(require('node:fs').readFileSync('ghost.json','utf8'))"`：通过。
- `git check-ignore -v ...`：源码与包位于 `_tmp/` 忽略目录。
- `git diff --check`：通过；本次 git 变更仅包含本证据文件。
- `ghost_forge_pack`：v1.0.1～v1.0.5 均通过；测试插件更新到 v1.0.5 并保持启用。
- `spike_ctx`：Codex 返回上下文；Claude Code 结果由 lead 提供。
- P0-3 task：completed；P0-4 三任务并发创建成功；P0-10 task：completed / `BLOCKED_NEEDS_USER`。
- P0-5：两小时读取 484/485。
