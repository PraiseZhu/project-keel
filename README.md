# Project Keel

Cindy 插件「KEEL」：可单独调用的 Jev 快速决策，加上完整复刻 pstack 的 PR 推进与修 bug 工作流（内嵌 Jev）

详细约定见 [CLAUDE.md](./CLAUDE.md)，版本管理见 [VERSIONING.md](./VERSIONING.md)。

云端检查见 [CI workflow](./.github/workflows/ci.yml)，在 PR、`main` 推送和手动触发时运行：

| 检查 | 内容 |
|---|---|
| Tests | Linux / Node 22 与 macOS / Node 24：示例 profile 构建、TypeScript、Vitest、上游测试用例完整性 |
| Plugin contracts and manuals | `ghost.json` 与生成脚本一致，手册路径 / 来源 / 文件限制，移植覆盖目标存在 |
| Secrets and privacy | Gitleaks，以及 tracked 文件与 HEAD 全历史的公开隐私检查 |
| CodeQL | JavaScript / TypeScript 与 GitHub Actions 的静态安全分析 |
| verify | 所有前置任务成功才通过；失败、取消或跳过都会阻断 |

`main` 的 required status check 使用固定名称 `verify`。CodeQL 分析任务成功表示扫描完成，发现的问题在仓库 Security 页面查看。

本地使用 `npm ci`、`npm run verify`、`npm run check:privacy`。CI 只使用公开示例 profile，不需要 Typesafe key 或本机配置；本机私有词名单仅在本机隐私扫描中生效。实机插件回放、三机一致性、live 迁移与付费 AI 审查另行验证，未计入 CI。
