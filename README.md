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

## 工具一览

插件共 15 个工具。

| 场景 | 工具 | 说明 |
| --- | --- | --- |
| 日常问 Jev | `jev` | 选项选择、评分、是非概率；只联网，不碰仓库 |
| 开始一次工作流 | `pstack_start` | 选 playbook 和深度，返回 run_id、手册路径与步骤 |
| 工作流中的判断点 | `pstack_decide` | 按阈值返回 act / reask / minimal / stop，并写台账 |
| 留痕与回看 | `pstack_ledger` | 读写运行台账（插件私有数据目录） |
| 看 PR | `pr_status`、`pr_wait`、`pr_board` | 只读；用本机 `gh` / `git` |
| 改 PR | `pr_open`、`pr_ready`、`pr_reply` | 写 GitHub；需要授权来源或弹确认框 |
| 评审线程分诊 | `pr_threads` | 统一分级 P0–P3，并给机器人评论处理建议 |
| worktree | `worktree` | create / audit / prune（只删干净且已合并的） |
| 派工角色 | `roles` | 读取本机 Orca 路由配置 |
| 多模型并行 | `fanout_plan`、`fanout_ingest` | arena / interrogate / swarm 三种并行方式 |

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

## 仓库内容

| 路径 | 说明 |
| --- | --- |
| `src/main/` | 插件沙箱侧工具（Jev、台账、PR、fanout 的入口） |
| `src/node/` | 随包 Node 工作进程：`gh` / `git` 调用、PR 判定、worktree、fanout、编排 CLI |
| `src/shared/` | 两侧共用的类型与协议 |
| `src/panel/` | 面板与设置页 |
| `plugin/` | 插件产物：`ghost.json`（由脚本生成）、手册、图标、构建输出 |
| `plugin/manual/` | 随插件分发的手册（`keel/`、`jev/`，以及工作流手册镜像） |
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
  - `fanout_ingest`：`arena` 模式下的任务描述，以及各候选的 diff、未跟踪文件路径和最多 3000 字符的报告正文；`interrogate` 模式下各审查者报告的发现。
- 其余工具（`pr_board`、`pr_open`、`pr_ready`、`pr_reply`、`worktree`、`roles`、`fanout_plan`、`pstack_ledger`）不向该服务发送内容。
- PR 相关工具只调用本机 `gh` / `git` 访问 GitHub，写操作（开 PR、转 Ready、回帖）每次都需要你的授权。
- 运行台账和判断留痕只写在插件私有数据目录，不上传。
- KEEL 本身不含遥测或使用统计。

## 许可证

本仓库自有代码使用 [MIT 许可证](LICENSE)。其中包含移植自第三方开源项目的部分，保留其原许可证，归属与变更记录见 [NOTICE](NOTICE)。
