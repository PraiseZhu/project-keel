# pstack → Cindy 插件 复刻覆盖清单

上游固定版本：`cursor/plugins@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a`（pstack 0.15.9）。本表复制自计划期覆盖清单，「Keel 落点」列改为仓内实际路径（scripts/port-check.mjs --init 生成），`UNMAPPED=0` 才算覆盖完整。生成日期：2026-10-04。

移植方式：A 原样移植（只替换宿主名词）；B 改写适配（行为改动写在备注）；C 代码移植（脚本 → Node 模块或工具）；D 由 Cindy 既有能力替代；E 不移植（备注写理由）。阶段 P1–P3 对应实施计划。

## 统计

| 维度 | 计数 |
|---|---|
| skill | 50 |
| playbook | 23 |
| agent | 2 |
| script | 20 |
| reference | 31 |
| automation | 3 |
| 合计 | 129 |

| 移植方式 | 计数 |
|---|---|
| A 原样移植 | 61 |
| B 改写适配 | 42 |
| C 代码移植 | 21 |
| D 由 Cindy 能力替代 | 1 |
| E 不移植 | 4 |

| 阶段 | 计数 |
|---|---|
| P1 | 80 |
| P2 | 13 |
| P3 | 32 |
| — | 4 |

UNMAPPED=0

## 明细

| 类型 | 上游路径 | 方式 | Keel 落点 | 阶段 | 备注 |
|---|---|---|---|---|---|
| skill | `skills/architect/SKILL.md` | B | `plugin/manual/pstack/skills/architect/SKILL.md` | P2 | runner 走 Orca 车道；Phase C 检查点保持 opt-in；是否需要 architect 由 Jev J2 深度分给出建议 |
| skill | `skills/arena/SKILL.md` | B | `plugin/manual/pstack/skills/arena/SKILL.md`<br>`src/main/fanout/tools.ts` | P2 | 候选在 <仓>/.worktrees/pstack-<run>-c<n>/；交叉评审车道；Jev J3 选基础候选 |
| skill | `skills/automate-me/SKILL.md` | B | `plugin/manual/pstack/skills/automate-me/SKILL.md` | P3 | 产物改为 Cindy Skill 或插件手册覆盖层；读历史须用户同意，不扫原始会话目录 |
| skill | `skills/benchmark-checklist/SKILL.md` | A | `plugin/manual/pstack/skills/benchmark-checklist/SKILL.md` | P1 |  |
| skill | `skills/blast-radius/SKILL.md` | A | `plugin/manual/pstack/skills/blast-radius/SKILL.md` | P1 | 增加 Jev J12「是否需要更多运行证据」 |
| skill | `skills/bro/SKILL.md` | A | `plugin/manual/pstack/skills/bro/SKILL.md` | P1 | 中文“说人话”改写 |
| skill | `skills/correct/SKILL.md` | B | `plugin/manual/pstack/skills/correct/SKILL.md` | P3 | 结构性约束（lint/测试/规则）只出提案，写入需当次授权 |
| skill | `skills/create-verification-skill/SKILL.md` | B | `plugin/manual/pstack/skills/create-verification-skill/SKILL.md` | P3 | control-ui/cli 换成 Cindy 浏览器、桌面、iOS 模拟器工具 |
| skill | `skills/figure-it-out/SKILL.md` | A | `plugin/manual/pstack/skills/figure-it-out/SKILL.md` | P1 | 决策留痕走 ledger_log |
| skill | `skills/how/SKILL.md` | B | `plugin/manual/pstack/skills/how/SKILL.md` | P1 | P1 用宿主原生 subagent；P2 可走 Orca 车道 |
| skill | `skills/interrogate/SKILL.md` | B | `plugin/manual/pstack/skills/interrogate/SKILL.md`<br>`src/main/fanout/tools.ts` | P2 | 审查模型按 routing.json 现读；Jev J4/J5 分诊；套用 P0–P3 统一分级；draft-gated-handoff 车道默认不跑 |
| skill | `skills/maintain-verification-skill/SKILL.md` | B | `plugin/manual/pstack/skills/maintain-verification-skill/SKILL.md` | P3 | 同 create-verification-skill |
| skill | `skills/make-bot-ui/SKILL.md` | D | `plugin/manual/pstack/skills/make-bot-ui/SKILL.md` | P3 | Grok Bot webhook/Tailscale 是 Cursor 专属；意图改为“用 Cindy 插件面板做自定义入口” |
| skill | `skills/no-comments/SKILL.md` | B | `plugin/manual/pstack/skills/no-comments/SKILL.md` | P1 | 默认只报告；发现多为 P3，按统一分级不自动修，用户点名才改 |
| skill | `skills/poteto-mode/SKILL.md` | B | `plugin/manual/pstack/skills/poteto-mode/SKILL.md`<br>`src/main/tools/pstack.ts` | P1 | 路由 + 非协商规则 + 用户规则覆盖层；持续模式先用工具结果续接，P3 评估 will-user-message 钩子 |
| skill | `skills/principle-attack-the-premise/SKILL.md` | A | `plugin/manual/pstack/skills/principle-attack-the-premise/SKILL.md` | P1 | 触发条件与规则原样保留 |
| skill | `skills/principle-boundary-discipline/SKILL.md` | A | `plugin/manual/pstack/skills/principle-boundary-discipline/SKILL.md` | P1 | 触发条件与规则原样保留 |
| skill | `skills/principle-build-the-lever/SKILL.md` | A | `plugin/manual/pstack/skills/principle-build-the-lever/SKILL.md` | P1 | 触发条件与规则原样保留 |
| skill | `skills/principle-encode-lessons-in-structure/SKILL.md` | A | `plugin/manual/pstack/skills/principle-encode-lessons-in-structure/SKILL.md` | P1 | 触发条件与规则原样保留 |
| skill | `skills/principle-exhaust-the-design-space/SKILL.md` | A | `plugin/manual/pstack/skills/principle-exhaust-the-design-space/SKILL.md` | P1 | 触发条件与规则原样保留 |
| skill | `skills/principle-experience-first/SKILL.md` | A | `plugin/manual/pstack/skills/principle-experience-first/SKILL.md` | P1 | 触发条件与规则原样保留 |
| skill | `skills/principle-explain-the-number/SKILL.md` | A | `plugin/manual/pstack/skills/principle-explain-the-number/SKILL.md` | P1 | 触发条件与规则原样保留 |
| skill | `skills/principle-fix-root-causes/SKILL.md` | A | `plugin/manual/pstack/skills/principle-fix-root-causes/SKILL.md` | P1 | 触发条件与规则原样保留 |
| skill | `skills/principle-foundational-thinking/SKILL.md` | A | `plugin/manual/pstack/skills/principle-foundational-thinking/SKILL.md` | P1 | 触发条件与规则原样保留 |
| skill | `skills/principle-guard-the-context-window/SKILL.md` | A | `plugin/manual/pstack/skills/principle-guard-the-context-window/SKILL.md` | P1 | 触发条件与规则原样保留 |
| skill | `skills/principle-laziness-protocol/SKILL.md` | A | `plugin/manual/pstack/skills/principle-laziness-protocol/SKILL.md` | P1 | 触发条件与规则原样保留 |
| skill | `skills/principle-make-operations-idempotent/SKILL.md` | A | `plugin/manual/pstack/skills/principle-make-operations-idempotent/SKILL.md` | P1 | 触发条件与规则原样保留 |
| skill | `skills/principle-migrate-callers-then-delete-legacy-apis/SKILL.md` | A | `plugin/manual/pstack/skills/principle-migrate-callers-then-delete-legacy-apis/SKILL.md` | P1 | 触发条件与规则原样保留 |
| skill | `skills/principle-minimize-reader-load/SKILL.md` | A | `plugin/manual/pstack/skills/principle-minimize-reader-load/SKILL.md` | P1 | 触发条件与规则原样保留 |
| skill | `skills/principle-model-the-domain/SKILL.md` | A | `plugin/manual/pstack/skills/principle-model-the-domain/SKILL.md` | P1 | 触发条件与规则原样保留 |
| skill | `skills/principle-never-block-on-the-human/SKILL.md` | A | `plugin/manual/pstack/skills/principle-never-block-on-the-human/SKILL.md` | P1 | 触发条件与规则原样保留 |
| skill | `skills/principle-outcome-oriented-execution/SKILL.md` | A | `plugin/manual/pstack/skills/principle-outcome-oriented-execution/SKILL.md` | P1 | 触发条件与规则原样保留 |
| skill | `skills/principle-prove-it-works/SKILL.md` | A | `plugin/manual/pstack/skills/principle-prove-it-works/SKILL.md` | P1 | 触发条件与规则原样保留 |
| skill | `skills/principle-redesign-from-first-principles/SKILL.md` | A | `plugin/manual/pstack/skills/principle-redesign-from-first-principles/SKILL.md` | P1 | 触发条件与规则原样保留 |
| skill | `skills/principle-separate-before-serializing-shared-state/SKILL.md` | A | `plugin/manual/pstack/skills/principle-separate-before-serializing-shared-state/SKILL.md` | P1 | 触发条件与规则原样保留 |
| skill | `skills/principle-sequence-verifiable-units/SKILL.md` | A | `plugin/manual/pstack/skills/principle-sequence-verifiable-units/SKILL.md` | P1 | 触发条件与规则原样保留 |
| skill | `skills/principle-subtract-before-you-add/SKILL.md` | A | `plugin/manual/pstack/skills/principle-subtract-before-you-add/SKILL.md` | P1 | 触发条件与规则原样保留 |
| skill | `skills/principle-test-behavior-not-implementation/SKILL.md` | A | `plugin/manual/pstack/skills/principle-test-behavior-not-implementation/SKILL.md` | P1 | 触发条件与规则原样保留 |
| skill | `skills/principle-type-system-discipline/SKILL.md` | A | `plugin/manual/pstack/skills/principle-type-system-discipline/SKILL.md` | P1 | 触发条件与规则原样保留 |
| skill | `skills/recall/SKILL.md` | B | `plugin/manual/pstack/skills/recall/SKILL.md` | P1 | 来源换成插件台账 + Cindy 历史检索；不跨工作区扫会话 |
| skill | `skills/reflect/SKILL.md` | B | `plugin/manual/pstack/skills/reflect/SKILL.md` | P3 | 改 skill 只出 diff 提案，写入需授权 |
| skill | `skills/setup-pstack/SKILL.md` | B | `plugin/manual/pstack/skills/setup-pstack/SKILL.md`<br>`src/node/routes/routing.ts` | P1 | 角色→模型从 routing.json 现读，不写 ~/.cursor |
| skill | `skills/show-me-your-work/SKILL.md` | C | `plugin/manual/pstack/skills/show-me-your-work/SKILL.md`<br>`src/main/ledger.ts` | P1 | TSV 存插件 data 目录，可导出到 <仓>/_tmp/pstack/ |
| skill | `skills/swarm/SKILL.md` | B | `plugin/manual/pstack/skills/swarm/SKILL.md`<br>`src/main/fanout/tools.ts` | P2 | cloud 环境改本机 Orca Worker；PASS/ISSUES/BLOCKED 报告结构保留 |
| skill | `skills/tdd/SKILL.md` | A | `plugin/manual/pstack/skills/tdd/SKILL.md` | P1 |  |
| skill | `skills/teach/SKILL.md` | A | `plugin/manual/pstack/skills/teach/SKILL.md` | P1 |  |
| skill | `skills/technical-writing/SKILL.md` | A | `plugin/manual/pstack/skills/technical-writing/SKILL.md` | P1 | PR 正文以目标仓模板为准（按目标仓 PR 模板） |
| skill | `skills/typescript-best-practices/SKILL.md` | A | `plugin/manual/pstack/skills/typescript-best-practices/SKILL.md` | P1 | paths 自动触发改为手册索引“编辑 TS 时读” |
| skill | `skills/unslop/SKILL.md` | B | `plugin/manual/pstack/skills/unslop/SKILL.md` | P1 | 保留英文规则，补中文写作对照规则 |
| skill | `skills/why/SKILL.md` | B | `plugin/manual/pstack/skills/why/SKILL.md` | P1 | MCP 发现换成 Cindy 已装插件：GitHub/GitLab/Slack/飞书/Atlassian/AKB2/Web Search；Databricks/Datadog/Sentry/Linear/Notion 无连接器时记缺口 |
| playbook | `skills/poteto-mode/playbooks/authoring-a-skill.md` | B | `plugin/manual/pstack/skills/poteto-mode/playbooks/authoring-a-skill.md` | P3 | create-skill 换成 cindy-skill-creator / 插件手册 |
| playbook | `skills/poteto-mode/playbooks/autonomous-run.md` | B | `plugin/manual/pstack/skills/poteto-mode/playbooks/autonomous-run.md` | P3 | /loop 换成会话内循环 + pr_wait + 用户保存的自动化 |
| playbook | `skills/poteto-mode/playbooks/autopilot-full.md` | B | `plugin/manual/pstack/skills/poteto-mode/playbooks/autopilot-full.md` | P3 | owner 停在 merge-ready，由用户在 GitHub 合并；一 PR 一 owner 走 Orca |
| playbook | `skills/poteto-mode/playbooks/autopilot-stack.md` | B | `plugin/manual/pstack/skills/poteto-mode/playbooks/autopilot-stack.md` | P3 | 同上，栈底向上由用户在 GitHub 落地 |
| playbook | `skills/poteto-mode/playbooks/babysit.md` | C | `plugin/manual/pstack/skills/poteto-mode/playbooks/babysit.md`<br>`src/main/tools/pr.ts` | P1 | watch-pr 移植进 Node；按车道停：交接车道交给自动化盯梢 即停手；永不合并；Bugbot/Greptile/🤖自动Review 用 Jev J5+J4 分诊 |
| playbook | `skills/poteto-mode/playbooks/bug-fix.md` | B | `plugin/manual/pstack/skills/poteto-mode/playbooks/bug-fix.md` | P1 | control 面换成 Cindy 浏览器/桌面/iOS 工具；/loop 换成会话内循环 + pr_wait |
| playbook | `skills/poteto-mode/playbooks/eval.md` | B | `plugin/manual/pstack/skills/poteto-mode/playbooks/eval.md` | P3 | 评测回放走 Orca 车道 |
| playbook | `skills/poteto-mode/playbooks/feature.md` | B | `plugin/manual/pstack/skills/poteto-mode/playbooks/feature.md` | P1 | “多种合理形态时必走 arena”保留，是否多形态由 Jev J10 判定，可被用户点名覆盖；arena 本身 P2 上线前降级为单候选并明示 |
| playbook | `skills/poteto-mode/playbooks/hillclimb.md` | B | `plugin/manual/pstack/skills/poteto-mode/playbooks/hillclimb.md` | P3 | /loop 换成 autonomous-run 循环 + 台账 |
| playbook | `skills/poteto-mode/playbooks/investigation.md` | A | `plugin/manual/pstack/skills/poteto-mode/playbooks/investigation.md` | P1 |  |
| playbook | `skills/poteto-mode/playbooks/multi-phase-plan.md` | C | `plugin/manual/pstack/skills/poteto-mode/playbooks/multi-phase-plan.md`<br>`src/node/plan/check-plan.ts` | P3 | check-plan.mjs 移植；计划文件落 ~/AI-Agent/Codex/plans/ 或目标仓 docs/ |
| playbook | `skills/poteto-mode/playbooks/opening-a-pr.md` | B | `plugin/manual/pstack/skills/poteto-mode/playbooks/opening-a-pr.md` | P1 | 按车道：draft-gated-handoff 车道 必 Draft，个人仓默认非 Draft；标题/正文以目标仓规则为准；开 PR 不自动 babysit |
| playbook | `skills/poteto-mode/playbooks/orchestrate.md` | C | `plugin/manual/pstack/skills/poteto-mode/playbooks/orchestrate.md`<br>`src/node/orch/store.ts` | P3 | orch store 移植；多 PR 计划默认交给 task-priority→approve-exec（用户 2026-10-04 裁决） |
| playbook | `skills/poteto-mode/playbooks/pause-safely.md` | B | `plugin/manual/pstack/skills/poteto-mode/playbooks/pause-safely.md` | P1 | resume note 写插件 data 目录；不 push 新东西 |
| playbook | `skills/poteto-mode/playbooks/perf-issue.md` | A | `plugin/manual/pstack/skills/poteto-mode/playbooks/perf-issue.md` | P3 |  |
| playbook | `skills/poteto-mode/playbooks/prototype.md` | A | `plugin/manual/pstack/skills/poteto-mode/playbooks/prototype.md` | P1 |  |
| playbook | `skills/poteto-mode/playbooks/refactoring.md` | A | `plugin/manual/pstack/skills/poteto-mode/playbooks/refactoring.md` | P1 |  |
| playbook | `skills/poteto-mode/playbooks/runtime-forensics.md` | A | `plugin/manual/pstack/skills/poteto-mode/playbooks/runtime-forensics.md` | P3 |  |
| playbook | `skills/poteto-mode/playbooks/session-pickup.md` | B | `plugin/manual/pstack/skills/poteto-mode/playbooks/session-pickup.md` | P1 | 来源换成插件台账 + Cindy 历史检索 |
| playbook | `skills/poteto-mode/playbooks/shipping.md` | B | `plugin/manual/pstack/skills/poteto-mode/playbooks/shipping.md` | P2 | 独立验证车道保留；落地改为报告可合并的验证 ceiling，由用户在 GitHub 合并（插件无合并能力）；patch-id 规则保留 |
| playbook | `skills/poteto-mode/playbooks/trace-forensics.md` | A | `plugin/manual/pstack/skills/poteto-mode/playbooks/trace-forensics.md` | P3 |  |
| playbook | `skills/poteto-mode/playbooks/visual-parity.md` | B | `plugin/manual/pstack/skills/poteto-mode/playbooks/visual-parity.md` | P3 | control-ui 换成 Cindy 浏览器截图 |
| playbook | `skills/poteto-mode/playbooks/worktree-cleanup.md` | C | `plugin/manual/pstack/skills/poteto-mode/playbooks/worktree-cleanup.md`<br>`src/node/git/worktree.ts` | P1 | worktree-audit 移植；只删干净且已合并的，含改动或在用一律停；删除前 confirm |
| agent | `agents/comment-sicko.md` | B | `plugin/manual/pstack/agents/comment-sicko.md`<br>`plugin/manual/keel/fanout/lanes/comment-sicko.md` | P1 | 只读报告 |
| agent | `agents/poteto-agent.md` | B | `plugin/manual/pstack/agents/poteto-agent.md`<br>`plugin/manual/keel/fanout/lanes/owner.md` | P2 | 不注册 agent 类型，改为派工包模板 |
| script | `skills/poteto-mode/scripts/bootstrap.ts` | E | — | — | 依赖预打包进 worker.cjs，运行期不安装 |
| script | `skills/poteto-mode/scripts/check-plan.mjs` | C | `src/node/plan/check-plan.ts` | P3 |  |
| script | `skills/poteto-mode/scripts/orch/orch.test.ts` | C | `tests/orch.test.ts` | P3 | 去掉 3 处 Bun API |
| script | `skills/poteto-mode/scripts/orch/orch.ts` | C | `src/node/orch/cli.ts`<br>`src/node/orch/rpc.ts` | P3 | commander 子命令改为 JSON-RPC 方法 |
| script | `skills/poteto-mode/scripts/orch/store.ts` | C | `src/node/orch/store.ts` | P3 | 纯 node:fs，近原样 |
| script | `skills/poteto-mode/scripts/package.json` | E | — | — | 由新仓 package.json 取代 |
| script | `skills/poteto-mode/scripts/watch-pr/cli.test.ts` | C | `tests/pr-rpc.test.ts` | P1 |  |
| script | `skills/poteto-mode/scripts/watch-pr/cli.ts` | C | `src/node/pr/upstream/cli.ts`<br>`src/node/rpc.ts` | P1 | CLI 改为 pr/status、pr/wait RPC |
| script | `skills/poteto-mode/scripts/watch-pr/fakes.test-helper.ts` | C | `tests/helpers/upstream-fakes.ts` | P1 |  |
| script | `skills/poteto-mode/scripts/watch-pr/github.test.ts` | C | `tests/github.test.ts` | P1 |  |
| script | `skills/poteto-mode/scripts/watch-pr/github.ts` | C | `src/node/pr/upstream/github.ts`<br>`src/node/env.ts` | P1 | gh 解析与环境沿用 pr-signoff 的 resolveGh/toolEnv |
| script | `skills/poteto-mode/scripts/watch-pr/policy.test.ts` | C | `tests/policy.test.ts` | P1 |  |
| script | `skills/poteto-mode/scripts/watch-pr/policy.ts` | C | `src/node/pr/upstream/policy.ts`<br>`src/shared/lanes.ts` | P1 | 纯函数近原样；外加车道覆盖层 |
| script | `skills/poteto-mode/scripts/watch-pr/render.ts` | C | `src/node/pr/upstream/render.ts`<br>`src/node/pr/snapshot.ts` | P1 | 输出改中文 |
| script | `skills/poteto-mode/scripts/watch-pr/tsconfig.json` | E | — | — | 由新仓 tsconfig 取代 |
| script | `skills/poteto-mode/scripts/watch-pr/types.compile.ts` | C | `src/node/pr/upstream/types.compile.ts` | P1 |  |
| script | `skills/poteto-mode/scripts/watch-pr/types.ts` | C | `src/node/pr/upstream/types.ts` | P1 | 近原样 |
| script | `skills/poteto-mode/scripts/watch-pr/watch-pr` | E | — | — | shell 包装器由 RPC 取代 |
| script | `skills/poteto-mode/scripts/worktree-audit.sh` | C | `src/node/git/worktree.ts` | P1 | transcript 信号换成 Cindy 会话工作目录信号或删除 |
| script | `skills/show-me-your-work/scripts/log.sh` | C | `src/main/ledger.ts`<br>`src/main/tools/pstack.ts` | P1 |  |
| reference | `skills/architect/references/design-red-flags.md` | A | `plugin/manual/pstack/skills/architect/references/design-red-flags.md` | P2 |  |
| reference | `skills/architect/references/rationale-template.md` | A | `plugin/manual/pstack/skills/architect/references/rationale-template.md` | P2 |  |
| reference | `skills/architect/references/runner-prompt.md` | A | `plugin/manual/pstack/skills/architect/references/runner-prompt.md` | P2 |  |
| reference | `skills/create-verification-skill/references/feature-map-example/README.md` | A | `plugin/manual/pstack/skills/create-verification-skill/references/feature-map-example/README.md` | P3 |  |
| reference | `skills/create-verification-skill/references/feature-map-example/create-note.md` | A | `plugin/manual/pstack/skills/create-verification-skill/references/feature-map-example/create-note.md` | P3 |  |
| reference | `skills/create-verification-skill/references/feature-map-example/search.md` | A | `plugin/manual/pstack/skills/create-verification-skill/references/feature-map-example/search.md` | P3 |  |
| reference | `skills/how/references/explainer-prompt.md` | A | `plugin/manual/pstack/skills/how/references/explainer-prompt.md` | P1 |  |
| reference | `skills/how/references/explorer-prompt.md` | A | `plugin/manual/pstack/skills/how/references/explorer-prompt.md` | P1 |  |
| reference | `skills/interrogate/references/code-quality-review.md` | A | `plugin/manual/pstack/skills/interrogate/references/code-quality-review.md` | P2 |  |
| reference | `skills/interrogate/references/lead-judgment.md` | A | `plugin/manual/pstack/skills/interrogate/references/lead-judgment.md` | P2 |  |
| reference | `skills/interrogate/references/reviewer-prompt.md` | A | `plugin/manual/pstack/skills/interrogate/references/reviewer-prompt.md` | P2 |  |
| reference | `skills/interrogate/references/rubric.md` | A | `plugin/manual/pstack/skills/interrogate/references/rubric.md` | P2 |  |
| reference | `skills/poteto-mode/references/bugbot-triage.md` | A | `plugin/manual/pstack/skills/poteto-mode/references/bugbot-triage.md` | P1 |  |
| reference | `skills/reflect/references/divergent-reviewer.md` | A | `plugin/manual/pstack/skills/reflect/references/divergent-reviewer.md` | P3 |  |
| reference | `skills/reflect/references/judgment-reviewer.md` | A | `plugin/manual/pstack/skills/reflect/references/judgment-reviewer.md` | P3 |  |
| reference | `skills/reflect/references/synthesizer.md` | A | `plugin/manual/pstack/skills/reflect/references/synthesizer.md` | P3 |  |
| reference | `skills/reflect/references/tooling-reviewer.md` | A | `plugin/manual/pstack/skills/reflect/references/tooling-reviewer.md` | P3 |  |
| reference | `skills/show-me-your-work/references/decision-log-template.tsv` | A | `plugin/manual/pstack/skills/show-me-your-work/references/decision-log-template.tsv.md` | P1 |  |
| reference | `skills/typescript-best-practices/references/patterns.md` | A | `plugin/manual/pstack/skills/typescript-best-practices/references/patterns.md` | P1 |  |
| reference | `skills/why/references/epistemics.md` | A | `plugin/manual/pstack/skills/why/references/epistemics.md` | P1 |  |
| reference | `skills/why/references/investigator-prompt.md` | A | `plugin/manual/pstack/skills/why/references/investigator-prompt.md` | P1 |  |
| reference | `skills/why/references/source-playbook.md` | A | `plugin/manual/pstack/skills/why/references/source-playbook.md` | P1 |  |
| reference | `skills/why/references/sources/code-archaeology.md` | B | `plugin/manual/pstack/skills/why/references/sources/code-archaeology.md` | P1 | 连接器换成 Cindy 已装插件，缺失者记缺口 |
| reference | `skills/why/references/sources/databricks.md` | B | `plugin/manual/pstack/skills/why/references/sources/databricks.md` | P1 | 连接器换成 Cindy 已装插件，缺失者记缺口 |
| reference | `skills/why/references/sources/datadog.md` | B | `plugin/manual/pstack/skills/why/references/sources/datadog.md` | P1 | 连接器换成 Cindy 已装插件，缺失者记缺口 |
| reference | `skills/why/references/sources/incident-postmortem.md` | B | `plugin/manual/pstack/skills/why/references/sources/incident-postmortem.md` | P1 | 连接器换成 Cindy 已装插件，缺失者记缺口 |
| reference | `skills/why/references/sources/linear.md` | B | `plugin/manual/pstack/skills/why/references/sources/linear.md` | P1 | 连接器换成 Cindy 已装插件，缺失者记缺口 |
| reference | `skills/why/references/sources/notion.md` | B | `plugin/manual/pstack/skills/why/references/sources/notion.md` | P1 | 连接器换成 Cindy 已装插件，缺失者记缺口 |
| reference | `skills/why/references/sources/sentry.md` | B | `plugin/manual/pstack/skills/why/references/sources/sentry.md` | P1 | 连接器换成 Cindy 已装插件，缺失者记缺口 |
| reference | `skills/why/references/sources/slack.md` | B | `plugin/manual/pstack/skills/why/references/sources/slack.md` | P1 | 连接器换成 Cindy 已装插件，缺失者记缺口 |
| reference | `skills/why/references/synthesizer-prompt.md` | A | `plugin/manual/pstack/skills/why/references/synthesizer-prompt.md` | P1 |  |
| automation | `automations/benny/skills/reproduce-and-fix-issues/SKILL.md` | B | `plugin/manual/pstack/automations/benny/skills/reproduce-and-fix-issues/SKILL.md` | P3 | 上游为休眠包；对接 issue-assess、Slack/飞书与 bug-fix playbook，外发与建单须授权 |
| automation | `automations/benny/skills/setup-benny/SKILL.md` | B | `plugin/manual/pstack/automations/benny/skills/setup-benny/SKILL.md` | P3 | 上游为休眠包；对接 issue-assess、Slack/飞书与 bug-fix playbook，外发与建单须授权 |
| automation | `automations/benny/skills/triage-issue-reports/SKILL.md` | B | `plugin/manual/pstack/automations/benny/skills/triage-issue-reports/SKILL.md` | P3 | 上游为休眠包；对接 issue-assess、Slack/飞书与 bug-fix playbook，外发与建单须授权 |
