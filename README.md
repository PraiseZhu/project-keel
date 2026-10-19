<p align="center">
  <img src="plugin/assets/icon.png" width="120" alt="KEEL">
</p>

<h1 align="center">KEEL</h1>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License" /></a>
  <a href="https://github.com/PraiseZhu/project-keel/actions/workflows/ci.yml"><img src="https://github.com/PraiseZhu/project-keel/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-22%2B-brightgreen.svg" alt="Node.js 22+" /></a>
</p>

KEEL 是一个 Cindy 插件，把两件事放在同一个安装包里：

- **Jev 快速决策**：日常对话里随时可问的分类、选项选择、评分和是非概率，不读写仓库。
- **PR 推进与修 bug 工作流**：开 PR、盯 CI、处理评审线程、管理 worktree、多模型并行审查，并在固定判断点自动问 Jev。

两组工具分开调用：只想问 Jev 时只用 `jev`，不会触发任何仓库操作。

KEEL 没有合并能力。PR 可合并时，它只报告状态和链接，由你自己在 GitHub 合并。

## 实时 PR 看板

插件面板与侧边栏主视图共用三列看板：**本地工作流（pro）→ 云端检查至全绿（pro）→ 已交接（mini 盯梢）**。沿用已确认的极夜/极光界面和动效，卡片208px，步骤号在线左，92×3px步骤线只用颜色标识当前段，没有圆点。旧面板的并行派工、决策台账和巡检按钮已移除；模型配置页与核心工具保留。

- 使用本机已登录的 `gh`，跨全部仓库分页读取当前 GitHub 账号创建的 PR，再补充本机 Keel 记录的关联 PR。不同仓库的同号 PR 不会合并；不再限前50条或15条。本人在其它电脑开出的 PR 也能从 GitHub 读到，不依赖聊天或本地仓库扫描。
- 默认显示进行中的 PR；切换「包含已合并 / 关闭」读取历史。界面可筛选仓库、任务名和编号；数据完整读取，每列超过40张时用「再显示」展开，数量不截断。
- 面板打开、返回前台和手动刷新时读取；可见时每30秒同步 GitHub，分页期间继续读取。数据量、网络、权限和 API 配额可能延迟刷新，界面明确标记未读完、部分不可读或失联；失败保留旧卡片，不显示成“没有 PR”。关闭或隐藏面板不持续轮询 GitHub。
- PR 生命周期、CI、评审从 GitHub 读取；具体任务步骤只取本机 Keel 的结构化回报。其它电脑的私有流程记录不自动同步；缺记录显示「步骤 ?」，Mini 内部盯梢步骤未接入时只显示已交接，绝不伪造进度。完成一轮 Keel 不等于 PR 已合并或仍在自动推进。
- GitHub 刷新不充当任务心跳。活动证据过期时停止显示“正在运行”；失联、隐藏页面或系统开启“减少动态效果”时停止循环动效。看板只读，不自动开任务、改 PR、合并或发布消息。

本地结构化步骤协议见 `plugin/manual/keel/MANUAL.md`；设计来源见 `docs/dashboard-source.md`，各类加载、筛选、PR和流程状态的预期见 `docs/dashboard-states.md`。开发预览用 `node scripts/dashboard-preview.mjs`；它使用明确标注的测试数据，不执行真实模型或 GitHub 写入。

查询直接使用运行插件那台电脑上的 GitHub CLI 有效授权（`gh api graphql --hostname github.com`），不是插件单独持有的 GitHub App 安装令牌。个人授权通常按账号共用每小时5000个 GraphQL 点数，而不是每小时5000个PR或每台电脑各5000次；实际额度及每个查询的cost以GitHub返回为准。REST和GraphQL分别计量，另有短时限流。面板隐藏停止后续轮询，配额不足时等待reset，手动刷新不会绕过退避。[GitHub官方限额说明](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)。

## 模型配置与执行

插件详情页分「我用 Claude Code 时 / 我用 Codex 时」两个标签页，各配「查资料、想方案、写代码、做检查」四行：查资料固定用主控自带的 sub，不需要选；想方案、写代码、做检查各选模型与推理强度，写代码和做检查可再配一个备用。下拉只列能跑通的组合（不出现 Pi，也不出现 Claude Code + Art Cindy 的 GPT），已保存但不可用的路线会标橙色说明，改掉后才能保存。高级区只留导出 / 导入 JSON 与恢复默认；Keel 角色不照搬 pstack 的 17 个角色。

派工原则：一次性任务（查资料）用主控自带的原生 sub，一次并行 3 个，只核对执行框架与主控一致；想方案、写代码、做检查各开 1 个 Worker。想方案用和主控不同的执行框架；做检查用和写代码不同的执行框架与模型族，运行时也会跳过与写手同框架的路线。备用模型是主选不可用时按顺序换用，不是并行协作。按任务类型分列的旧配置不再生效，保存时不修改其它 KV 设置。

Worker 的模型、provider、框架、推理强度按设置原样派出，回执不一致即报错；主路线不可用时按备用顺序降级并写明原因，用尽即停。查资料 sub 失败后不会改开 Worker。Worker 明确使用本机来源、Fast 关闭，避免继承主会话的其它来源或速度。

每次新派工重读配置与本机已启用模型目录；已派出的节点保留它的路线快照。旧独立 fanout 的 roles/plan 是全局路由入口，不读取此页配置；设置页多模型任务走 keel_run 的 subagents。具体回执合同见 `plugin/manual/keel/MANUAL.md` 的「subagent 派工」。

## 工具一览

插件共 16 个工具。

| 场景 | 工具 | 说明 |
| --- | --- | --- |
| 日常问 Jev | `jev` | 选项选择、评分、是非概率；只联网，不碰仓库 |
| 开一次图运行 | `keel_run` | 聊清需求后调用，必须带 `lead`（codex / claude-code / pi） |
| 开始一次 pstack 任务 | `pstack_start` | 迁移入口：必须带 `lead`；`task` 映射为 `goal` |
| 工作流中的判断点 | `pstack_decide` | 按阈值返回 act / reask / minimal / stop，并写台账 |
| 留痕与回看 | `pstack_decide`（op=log / read） | 读写运行台账（插件私有数据目录） |
| 看 PR | `pr_status`（board:true 出看板）、`pr_wait` | 只读；用本机 `gh` / `git` |
| 改 PR | `pr_open`、`pr_ready`、`pr_reply` | 写 GitHub；pr_open / pr_ready 需要授权来源，pr_reply 默认直接发表（可在设置页改为每条确认） |
| 评审线程分诊 | `pr_threads` | 统一分级 P0–P3，并给机器人评论处理建议 |
| worktree | `worktree` | create / audit / prune（只删干净且已合并的） |
| 派工角色 | `fanout`（op=roles） | 读取本机 Orca 路由配置 |
| 多模型并行 | `fanout`（op=plan / ingest） | arena / interrogate / swarm 三种并行方式 |

工具的完整用法、工作流手册和规则覆盖层随插件安装，在 Cindy 里通过 `ghost_manual({ ghost_id: "keel", path: "keel/MANUAL.md" })` 查看，源文件在 [`plugin/manual/`](plugin/manual/)。

## PR 车道

每个仓按车道决定 PR 怎么走，车道在个人 profile 里配置：

| 车道 | 行为 |
| --- | --- |
| `personal`（默认） | 非 Draft，到 READY 即停 |
| `gated-handoff` | 必需检查全绿才转 Ready，Ready 后交给自动化盯梢，作者停手 |
| `draft-gated-handoff` | 在上一条基础上强制 Draft，并按 base 分支规则校验标题与必需检查 |

交接后再做推送、回帖、修复类调用会返回 `LANE_HANDED_OFF`。

任一车道都可以配 `verifyCheck`（例如 `agent-verify`）。当前提交没有这个 GitHub 状态通过时，KEEL 不报可合并，也不转 Ready，下一步固定为「验证当前提交」：由不是作者的模型验证后，给这个提交写状态。代码一改，旧状态就不属于新提交，需要重新验证。建议同时在仓库分支保护里把它设为必需检查。KEEL 不核验状态由谁写入：本机 agent 共用同一个 GitHub 账号时，这道门防疏忽、不防蓄意伪造。

交接车道可配置 `handoffHelperPath`，指向已部署的 Vigil `mivo-handoff.mjs` 绝对路径（需支持 `inspect` 和 `handoff --expected-head`）。本机需安装可从 PATH 或常见安装位置找到的 Node CLI；Cindy 内置 Node worker 不替代该外部执行器。配置后，`pr_ready` 在当前 HEAD 的 CI、审查进场和作者身份核对通过后转 Ready，自动发布并读回作者交接回执，最后才写本地交接记录；`dry_run` 不发布。读取失败或 HEAD 漂移时不声称交接成功。重复调用复用同代次回执，转 Draft 或进入新 Ready 代次后，过期本地记录不再锁住作者。外部有效回执也会拦住丢失本地记录的作者会话。未配置的车道保留原有本地交接行为。

## 仓库内容

| 路径 | 说明 |
| --- | --- |
| `src/main/` | 插件沙箱侧工具（Jev、台账、PR、fanout 的入口） |
| `src/node/` | 随包 Node 工作进程：`gh` / `git` 调用、PR 判定、worktree、fanout、编排 CLI |
| `src/shared/` | 两侧共用的类型与协议 |
| `src/panel/` | 面板与设置页 |
| `plugin/` | 插件产物：`ghost.json`（由脚本生成）、手册、图标、构建输出 |
| `plugin/manual/` | 随插件分发的手册（`keel/`、`jev/`，以及工作流手册镜像） |
| `plugin/hooks/` | 收工钩子（`keel-stop-gate.js`，用 macOS 自带的 `osascript -l JavaScript` 运行，不需要装 Node）和 Claude Code 一次性节点 subagent（`keel-node.md`）。插件每次启动时自动装进 `~/.claude/settings.json`、Cindy 的 Codex `hooks.json` 和 `~/.claude/agents/`；只装已有配置目录的 harness。卸载插件后，钩子下一次触发时发现脚本不在，会把自己的条目和 `keel-node.md` 删掉再放行。Codex 只运行用户信任过的钩子，第一次要在 Codex 里信任一次 |
| `overlays/`、`tools/` | 手册镜像的覆盖层与同步脚本 |
| `config/` | 个人 profile 示例（`profile.example.json`） |
| `scripts/` | 构建、manifest 生成、手册校验、隐私检查 |
| `tests/` | Vitest 测试 |

## 前置要求

- Node.js 22 或更高
- 使用 PR 相关工具时，本机需要已登录的 `gh` 和 `git`
- Jev 需要一个 Typesafe API Key，在插件设置页里填写；Key 只进主机保险库，插件代码和 AI 都拿不到明文

## 开始使用

```bash
git clone https://github.com/PraiseZhu/project-keel.git
cd project-keel
npm ci
cp config/profile.example.json config/profile.local.json   # 按需改成自己的车道与路径
npm run build
```

`config/profile.local.json` 不入库。没有它时，构建使用 `config/profile.example.json`。

构建完成后，在 Cindy 里用 `ghost_forge_pack` 打包 `plugin/` 目录，再导入生成的 `.cindy` 文件；也可以在 Cindy 中让 Agent 调用 `ghost_forge_install` 直接安装。安装后在对话里用 `$keel …` 或直接调用 `jev`、`pstack_start` 等工具。

## 开发

```bash
npm run build          # 构建插件与 Node 工作进程
npm run typecheck      # TypeScript 类型检查
npm test               # Vitest
npm run lint:manual    # 手册路径、来源与文件大小限制
npm run port-check     # 移植覆盖检查
npm run verify         # 以上全部
npm run check:privacy  # 公开隐私检查（只读）
```

`plugin/ghost.json` 由 `scripts/manifest.mjs` 生成，不要手改。手册镜像用 `npm run sync` 更新。

### 云端检查

[CI workflow](.github/workflows/ci.yml) 在 PR、`main` 推送和手动触发时运行：

| 检查 | 内容 |
| --- | --- |
| Tests | Linux / Node 22 与 macOS / Node 24：示例 profile 构建、TypeScript、Vitest、移植用例完整性 |
| Plugin contracts and manuals | `ghost.json` 与生成脚本一致，手册路径 / 来源 / 文件限制，移植覆盖目标存在 |
| Secrets and privacy | Gitleaks，以及 tracked 文件与 HEAD 全历史的公开隐私检查 |
| CodeQL | JavaScript / TypeScript 与 GitHub Actions 的静态安全分析 |
| verify | 所有前置任务成功才通过；失败、取消或跳过都会阻断 |

`main` 的 required status check 是 `verify`。CI 只用公开示例 profile，不需要 API Key 或本机配置。实机插件回放和付费 AI 审查不在 CI 内，另行验证。

## 贡献

通过 pull request 向 `main` 提交，需要 `verify` 通过且评审线程全部解决。版本与提交约定见 [VERSIONING.md](VERSIONING.md)，项目约定见 [CLAUDE.md](CLAUDE.md)。

## 安全

不要把密钥、token 或授权文件提交进仓库。发现安全问题，请先私下联系仓库维护者，不要在公开 issue 里披露细节。CodeQL 的扫描结果在仓库 Security 页面查看。

## 隐私

- 以下工具会把内容发送到 Jev 判断服务，私有仓库里的内容也在其中，请按需使用：
  - `jev`：你提交的问题和选项。
  - `pstack_start`、`pstack_decide`：任务描述和判断点的上下文。
  - `pr_status`、`pr_wait`（返回前的最终判断）：PR 的摘要（标题、分支、检查结果）；检查失败时还包括失败项。
  - `pr_threads`：评审线程和机器人评论的正文。
  - `fanout`（op=ingest）：`arena` 模式下的任务描述，以及各候选的 diff、未跟踪文件路径和最多 3000 字符的报告正文；`interrogate` 模式下各审查者报告的发现。
- 其余工具（`pr_status` 的看板模式、`pr_open`、`pr_ready`、`pr_reply`、`worktree`、`fanout` 的 plan / roles、`pstack_decide` 的 log / read）不向该服务发送内容。
- PR 相关工具只调用本机 `gh` / `git` 访问 GitHub，写操作（开 PR、转 Ready、回帖）每次都需要你的授权。
- 运行台账和判断留痕只写在插件私有数据目录，不上传。
- KEEL 本身不含遥测或使用统计。

## 许可证

本仓库自有代码使用 [MIT 许可证](LICENSE)。其中包含移植自第三方开源项目的部分，保留其原许可证，归属与变更记录见 [NOTICE](NOTICE)。
