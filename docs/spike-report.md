# P0 平台 spike 报告

日期：2026-10-04。执行者：Keel 执行 Worker（Claude Code harness）。插件以 `ghost_forge_install` 装到本机 Cindy 0.1.97 后实测；没有另建一次性 `pstack-spike` 插件，探针直接跑在 Keel 本体上（同一套能力，少一次装卸）。

RESULT: PASS gh-node — Node worker 在 Host 裁剪后的环境里（无 HOME）经 `resolveTool/toolEnv` 找到 gh 与 git；`env/diagnose` 返回 gh_user 正常；`pr_board` 列出 2 个 open PR，`pr_status` 读取一条 Draft PR 的完整快照（25 项检查、10 条未解决线程、必需检查 7 项）。
RESULT: PASS jev-own-key — 用户填 Key 后，插件自带 secret 经 `cindy.fetch` 调 `/v1/systemone`：11 次（pstack_start 的 J1+J2 合并请求 1 次 + jev 工具 10 次）全部 HTTP 200，0 错误；Host 日志计时 p50 0.46 秒、p95 0.60 秒、最大 0.60 秒（远低于 15 秒停止线）。未填 Key 时返回结构化 `JEV_NOT_CONFIGURED`，PR 工具照常降级运行。
RESULT: FAIL orca-worktree — 半段通过：`fanout_plan` 现读 routing.json 生成三家族车道（codex/gpt-6-sol、pi/grok-4.6、claude-code/z-ai/glm-5.3），写车道 worktree 由 Node 预建在 `<仓>/.worktrees/pstack-<id>-<label>/`（单测用真实 git 仓验证）。未完成：本 Worker 是 Orca Worker，按规则不能 `start_team` / `create_workers`，三个 lead harness 下的真实派发需要 lead 执行。不是架构失败。
RESULT: FAIL card-continue — 未实现：首版没有声明 card 能力，也没有卡片按钮续接；按计划属于可调整项（不停）。
RESULT: FAIL panel-node-confirm — 半段通过：`pr_reply` 内的 `cindy.confirm` 链路实测成功（Host 日志 `ghost confirm answered { confirmed: true }`，用户点了发表，PR #2 留下一条探针评论）。面板「刷新」→ BroadcastChannel → main.js → Node 的链路代码与 `pr_board` 工具共用同一处理函数，但没有在面板 UI 上点按实测。需用户或 lead 打开面板点一次「刷新」确认。
RESULT: PASS manual-deep-path — `ghost_manual` 读取 `pstack/skills/poteto-mode/playbooks/investigation.md`（四层）成功，Manual 根索引列出 keel / pstack / jev 三个单元。
RESULT: FAIL hook-rewrite — 未实现：`will-user-message` 需要 `launch:"resident"` 独立版本，首版保持 on-demand，持续模式未上线（计划允许调整，不停）。
RESULT: FAIL tasks-probe — 未探测：首版不依赖 `cindy.tasks`，没有写探测代码；记为 P3 待办。
RESULT: FAIL remote-install — 半段通过：两台远端经 cindy_ssh 只读探查，Cindy 均为 0.1.97，routing.json 均存在且与本机 sha256 相同（`21d4e38c…`）。安装途径：远端没有可从本机驱动的 Cindy 会话，`ghost_forge_install` 只能在该机 Cindy 会话内调用，因此需用户在两台打开同一个 `.cindy` 导入（Syncthing 已把工程目录含 `_tmp/` 同步过去）。发现：Syncthing 同步了 `Project Keel/.git`，与 git 构成双通道（远端 HEAD 停在旧提交），见 docs/triad.md。

## 平台发现（影响实现）

1. **Host 启发式 Setup 拦截**：声明了 `source:"user"` 的 secret 而不声明 `setup` 时，Host 认为 Key 是全部工具的前置条件，所有工具调用卡在 Setup 卡上等满 10 分钟后 `TIMEOUT`（`ghostSetupCoordinator` 的 `DEFAULT_SETUP_TIMEOUT_MS`）。已在 manifest 写 `"setup": { "requires": [] }`，Key 变为可选。
2. `keywords` 字段已被 Host 废弃（manifest.ts 注释：2026-07-14 起不再消费），计划里列的 6 个 keywords 没有写入 manifest。
3. Jev 的 score 题返回的是期望值（如 1.23），不是整数档位；J2 深度按数值比较（≥2 建议 architect、≥3 建议 arena）。
