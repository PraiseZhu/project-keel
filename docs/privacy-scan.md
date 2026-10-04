# 公开前隐私扫描

- 日期：2026-10-04
- 范围：`git ls-files` 244 个文件 + HEAD 可达的全部提交（逐行扫描新增内容）
- 规则：本机绝对路径、邮箱、GitHub/sk token、Bearer 字面量、.env 文件、个人 profile 的私有名单（9 项，名单本身不入库）
- 结果：**命中 2 处，阻断公开**

| 位置 | 规则 | 内容（已脱敏） |
|---|---|---|
| docs/replays/S3.md:18 | private-term:9ch | `- r1 'codex / gpt-6-sol / high'（«private»，review 主档）` |
| docs/replays/S3.md:19 | private-term:9ch | `- r2 'pi / grok-4.6 / high'（«private»，execute 主档）` |
