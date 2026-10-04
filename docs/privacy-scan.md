# 公开前隐私扫描

- 时间：2026-10-04T12:34:14.675Z
- 范围：`git ls-files` 227 个文件 + HEAD 可达的全部提交（逐行扫描新增内容）
- 规则：本机绝对路径、邮箱、GitHub/sk token、Bearer 字面量、.env 文件、个人 profile 的私有名单（9 项，名单本身不入库）
- 结果：**命中 15 处，阻断公开**

| 位置 | 规则 | 内容（已脱敏） |
|---|---|---|
| docs/coverage-map.md:50 | private-term:4ch | `\| skill \| 'skills/interrogate/SKILL.md' \| B \| 'plugin/manual/pstack/skills/interrogate/SKILL.md'<br>'src/main/fanout/too` |
| docs/coverage-map.md:86 | private-term:4ch | `\| skill \| 'skills/technical-writing/SKILL.md' \| A \| 'plugin/manual/pstack/skills/technical-writing/SKILL.md' \| P1 \| PR 正` |
| docs/coverage-map.md:94 | private-term:4ch | `\| playbook \| 'skills/poteto-mode/playbooks/babysit.md' \| C \| 'plugin/manual/pstack/skills/poteto-mode/playbooks/babysit.` |
| docs/coverage-map.md:101 | private-term:4ch | `\| playbook \| 'skills/poteto-mode/playbooks/opening-a-pr.md' \| B \| 'plugin/manual/pstack/skills/poteto-mode/playbooks/ope` |
| plugin/manual/pstack/skills/recall/SKILL.md:13 | absolute-home-path | `Transcripts live at '~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl', where '<slug>' is the workspace p` |
| src/node/pr/upstream/github.ts:176 | email | `if (normalized.startsWith("git@github.com:"))` |
| src/node/pr/upstream/github.ts:178 | email | `if (normalized.startsWith("ssh://git@github.com/"))` |
| history 048461d | private-term:4ch | `\| playbook \| 'skills/poteto-mode/playbooks/opening-a-pr.md' \| B \| 'plugin/manual/pstack/skills/poteto-mode/playbooks/ope` |
| history 048461d | absolute-home-path | `Transcripts live at '~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl', where '<slug>' is the workspace p` |
| history b893fee | email | `if (normalized.startsWith("ssh://git@github.com/"))` |
| history b893fee | private-term:4ch | `{ repo: "«private»/«private»-canvas-plugin", lane: "«private»" },` |
| history b893fee | private-term:7ch | `{ repo: "«private»/«private»-canvas-plugin", lane: "«private»" },` |
| history b893fee | private-term:15ch | `{ repo: "«private»", lane: "cindy" },` |
| history b893fee | absolute-home-path | `"«private»/AI-Agent/Claude/capabilities/source/skills/claude-active/cindy-pr-preflight/preflight.sh",` |
| history b893fee | private-term:13ch | `"«private»/AI-Agent/Claude/capabilities/source/skills/claude-active/cindy-pr-preflight/preflight.sh",` |
