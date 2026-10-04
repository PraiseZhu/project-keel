# pstack 上游镜像（Keel）

> 镜像自 cursor/plugins pstack 0.15.9 @ e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a（MIT，© 2026 Lauren Tan）。由 `tools/sync.mjs` 生成，勿手改。

正文保留上游英文；每个文件首行写明来源与改写方式。**中文规则覆盖层与 Cursor→Cindy 对照在 `keel` 手册单元**：`ghost_manual({ ghost_id: "keel", path: "keel/MANUAL.md" })`，与上游冲突时以覆盖层为准。

## 怎么用

1. 先调 `pstack_start({ task })`，它用 Jev 选 playbook 并给出下面表里的路径；用户点名 playbook 时传 `playbook`。
2. 路由与非协商规则：`ghost_manual({ ghost_id: "keel", path: "pstack/skills/poteto-mode/SKILL.md" })`。
3. 判断点用 `pstack_decide`（J1–J12），留痕用 `pstack_ledger`。

## Playbooks（23）

| 路径 | 开头规则 |
|---|---|
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/poteto-mode/playbooks/authoring-a-skill.md" })` | You own the skill's voice. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/poteto-mode/playbooks/autonomous-run.md" })` | You own the exit condition. Define done, then drive to it without stopping. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/poteto-mode/playbooks/autopilot-full.md" })` | You own the verdicts, never the PRs. One owner runs each PR from build to merge, and nothing merges without your clean swarm verdict. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/poteto-mode/playbooks/autopilot-stack.md" })` | You own the stack, never the landing. Build and verify the queue with full autonomy, then hand the operator one linear base-branch stack to review and land. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/poteto-mode/playbooks/babysit.md" })` | You own the merge frontier. Declare a mode, clear one PR at a time, stop where the human's call begins. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/poteto-mode/playbooks/bug-fix.md" })` | You own this task. Plan, review, verify. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/poteto-mode/playbooks/eval.md" })` | You own the experiment design. Plan, blind, run, synthesize. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/poteto-mode/playbooks/feature.md" })` | You own the design. Plan, review, verify. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/poteto-mode/playbooks/hillclimb.md" })` | You own the metric and the experiment's integrity. Supervise and review. Delegate the attempts. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/poteto-mode/playbooks/investigation.md" })` | You own the answer. Plan, route, write. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/poteto-mode/playbooks/multi-phase-plan.md" })` | You own the plan, not the code. The plan is a checklist an owner runs box by box and the operator audits from the evidence. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/poteto-mode/playbooks/opening-a-pr.md" })` | Worktree. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/poteto-mode/playbooks/orchestrate.md" })` | You own the program, never the code. Author briefs, drain the queue, keep the frontier green, decide. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/poteto-mode/playbooks/pause-safely.md" })` | You own a clean stop. Leave a checkpoint a cold-start agent can resume from. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/poteto-mode/playbooks/perf-issue.md" })` | You own the measurement story. Plan, review, verify the numbers. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/poteto-mode/playbooks/prototype.md" })` | You own the design decision, not the code. The prototype is a throwaway instrument. The real build follows Feature. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/poteto-mode/playbooks/refactoring.md" })` | You own the contract. The structure changes. The behavior does not. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/poteto-mode/playbooks/runtime-forensics.md" })` | You own the diagnosis. Instrument the live process, don't theorize from source. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/poteto-mode/playbooks/session-pickup.md" })` | You own the resume point. Read the prior trail, don't redo it. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/poteto-mode/playbooks/shipping.md" })` | You own what lands. Verify each PR independently, land only the verified run from the root, then keep your hands off the queue. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/poteto-mode/playbooks/trace-forensics.md" })` | You own the diagnosis from the artifact. Load it, shape it, narrow to the cause, attribute to source. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/poteto-mode/playbooks/visual-parity.md" })` | You own pixel-exact equivalence. The baseline is the spec. You do not touch it. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/poteto-mode/playbooks/worktree-cleanup.md" })` | You own the disk and the safety gate. |

## Skills（50）

| 路径 | 上游说明 |
|---|---|
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/architect/SKILL.md" })` | Sketch types, signatures, and module structure before code, then stay in the loop while implementation fills in. Use for /architect, 'architect this', 'design this', or non-trivial work where jumping  |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/arena/SKILL.md" })` | Spawn N parallel candidates at the same task, pick a base, graft the strongest parts of the losers into it. Use for /arena, 'arena this', 'throw it in the arena', or when one attempt at a non-trivial  |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/automate-me/SKILL.md" })` | Use for \"automate me\", \"create/update/refresh my -mode skill\", \"turn/capture my preferences or working style into a skill\", or wanting agents to follow how the user works. Drafts or revises a pe |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/benchmark-checklist/SKILL.md" })` | Vet a perf measurement (limiter, tuning, limits, errors, repeatability, relevance, and whether the work happened) before you report or act on it. Use when you run a benchmark or report a speedup or re |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/blast-radius/SKILL.md" })` | Find what a change could break somewhere else before it ships, beyond the diff, and prove the one fact it's safe because of by running real code instead of writing it up. Use for 'blast radius of X',  |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/bro/SKILL.md" })` | Restate the last message in plain human language, with no jargon. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/correct/SKILL.md" })` | Find the mistakes agents keep repeating in this repo and make each one impossible. Try architecture first, then types, then a lint whose error names the fix, then a test, and write docs last. Prove ea |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/create-verification-skill/SKILL.md" })` | Generate a project-local verification skill that drives your app the way a user does — any language, framework, or platform. Use for /create-verification-skill, \"make a control skill for this repo\", |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/figure-it-out/SKILL.md" })` | Design an auditable playbook when no narrower one fits: a large migration, an ambitious multi-part change, or work a human reviews after stepping away. Scales rigor to the task, runs a hypothesis loop |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/how/SKILL.md" })` | Use for \"how does X work\", code walkthroughs before changing something, and placement / ownership / layering questions (\"where should this live\", \"which package owns this\", \"is this the right l |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/interrogate/SKILL.md" })` | Use for \"interrogate\", \"adversarial review\", \"multi-model review\", \"challenge this\", \"stress test this code\", \"find blind spots\", or \"tear this apart\". Multiple LLM reviewers challenge c |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/maintain-verification-skill/SKILL.md" })` | Periodic pass that keeps a project's verification skill and feature map honest: parallel source readers per feature, one live session driving every feature, at most one PR of proven corrections. Use f |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/make-bot-ui/SKILL.md" })` | >- |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/no-comments/SKILL.md" })` | Spawn Comment Sicko, fix accepted findings, and offer encodings for claimed constraints. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/poteto-mode/SKILL.md" })` | poteto's agent style for concise, detailed responses, deliberate subagents, unslopped prose, simple code, and verified work. Use for poteto, /poteto-mode, or requests to work in this style. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/principle-attack-the-premise/SKILL.md" })` | Apply when two or more fixes that share one premise have failed the same gate. Take a census of which actors hold the imbalance before the next fix, then question the premise instead of writing anothe |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/principle-boundary-discipline/SKILL.md" })` | Apply when wiring validation, error handling, or framework adapters. Concentrate guards at system boundaries (CLI, config, network, external APIs); trust internal types and keep business logic in pure |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/principle-build-the-lever/SKILL.md" })` | Apply to any non-trivial work, not just bulk work: edits, migrations, analyses, checks. Build the tool that does it or proves it (codemod, script, generator, or a skill your subagents follow) instead  |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/principle-encode-lessons-in-structure/SKILL.md" })` | Apply when you catch yourself writing the same instruction a second time, or notice a recurring correction. Encode the rule as a lint, metadata flag, runtime check, or script instead of more text. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/principle-exhaust-the-design-space/SKILL.md" })` | Apply when facing a novel UI interaction or architectural decision with no precedent in the codebase. Build 2-3 competing prototypes and compare side by side before committing. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/principle-experience-first/SKILL.md" })` | Apply when product, UX, or feature-scope tradeoffs come up. Choose user delight over implementation convenience; ship fewer polished features over more rough ones. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/principle-explain-the-number/SKILL.md" })` | Apply before you trust, report, or act on a number you measured: a speedup, a regression, a throughput, a latency, or an eval result. Find what limits it, and rule out that it measured something other |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/principle-fix-root-causes/SKILL.md" })` | Apply when debugging. Trace each symptom to its root cause and fix it there; reproduce first, ask why until you reach it, resist nil-check guards that silence crashes. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/principle-foundational-thinking/SKILL.md" })` | Apply before writing logic: choosing core types and data structures, sequencing scaffold-vs-feature work, asking what concurrent actors share. Get the data structures right so downstream code becomes  |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/principle-guard-the-context-window/SKILL.md" })` | Apply when context is filling up: large outputs, long files, repeated reads, fan-out planning. Route bulk to subagents; keep summaries in the main thread, not raw payloads. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/principle-laziness-protocol/SKILL.md" })` | Apply when refactoring, evaluating diff size, or tempted to add abstractions, layers, or signal threading. Bias toward deletion and the smallest change that solves the problem. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/principle-make-operations-idempotent/SKILL.md" })` | Apply when designing commands, lifecycle steps, or processing loops that run amid crashes, restarts, and retries. Converge to the same end state regardless of partial prior runs. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/principle-migrate-callers-then-delete-legacy-apis/SKILL.md" })` | Apply when introducing a new internal API while old callers still exist. Migrate callers and delete the old API in the same wave instead of preserving compatibility layers. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/principle-minimize-reader-load/SKILL.md" })` | Apply when reviewing or shaping code that's hard to trace. Count layers between question and answer, and hidden state in the reader's head; collapse one-caller wrappers and shrink mutable scope. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/principle-model-the-domain/SKILL.md" })` | Apply when writing stateful logic, or when code branches a lot or repeats a shape assumption across files. Encode the domain in a structure instead of scattered conditionals. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/principle-never-block-on-the-human/SKILL.md" })` | Apply when tempted to ask 'should I do X?' on reversible work. Proceed, present the result, let the human course-correct after the fact; reserve confirmation for irreversible actions. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/principle-outcome-oriented-execution/SKILL.md" })` | Apply during planned rewrites and migrations with explicit phase boundaries. Converge on the target architecture; don't preserve smooth intermediate states with throwaway compatibility code. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/principle-prove-it-works/SKILL.md" })` | Apply after completing a task, before declaring done. Verify against the real artifact (run the feature, read the actual value, inspect the diff), not a proxy, self-report, or 'it compiles.' |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/principle-redesign-from-first-principles/SKILL.md" })` | Apply when integrating a new requirement into an existing design. Redesign as if the requirement had been a foundational assumption from day one, instead of bolting it on. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/principle-separate-before-serializing-shared-state/SKILL.md" })` | Apply when concurrent actors might write to the same file, branch, key, or state object. Eliminate the sharing first; serialize structurally only when one shared writer is a real invariant. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/principle-sequence-verifiable-units/SKILL.md" })` | Apply to multi-step work (sweeps, migrations, runs of similar edits) and to how you stack commits and PRs. Break work into small units that each end in a verifiable state, check each before the next,  |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/principle-subtract-before-you-add/SKILL.md" })` | Apply when sequencing an addition, refactor, or rewrite. Remove dead code, redundant validators, and stub references first, then build on the simpler base. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/principle-test-behavior-not-implementation/SKILL.md" })` | Apply when you write, change, or keep a test. Call the code the way its users do and assert the result they observe against a literal expected value. If the test would still pass when every imported f |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/principle-type-system-discipline/SKILL.md" })` | Apply when designing types, reviewing a function signature, or writing code in any statically-typed language. Make illegal states unrepresentable, brand semantic primitives, parse external data at bou |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/recall/SKILL.md" })` | Reconstruct your recent working context from your own chat history, live state, and the shared record (user reports, prior fixes, incidents), then hand back a tight current-state brief. Use for 'recal |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/reflect/SKILL.md" })` | Spawn three parallel review subagents over the active transcript, surface learnings, and route each to a concrete edit on an existing skill. Use when the user says reflect. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/setup-pstack/SKILL.md" })` | Configure which models pstack uses per role and at what reasoning budget. Detects your available models and writes an always-applied rule that overrides the skill defaults. Use for /setup-pstack, "con |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/show-me-your-work/SKILL.md" })` | Keep a reviewable decision trail for long-running or unattended work: a TSV log with one row per decision (what, why, evidence, result). Local by default; commit it when a reviewer needs the trail to  |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/swarm/SKILL.md" })` | Fan out N parallel workers, drain them, and return one report. Use for /swarm, 'swarm this', or parallel coverage, races, gauntlets, and exploration. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/tdd/SKILL.md" })` | Use only when the user explicitly asks for TDD, a failing test, or a regression test, OR when the bug has an obvious cheap local test target. Skip when the test path is unclear, expensive, integration |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/teach/SKILL.md" })` | Explain a body of work plainly so a person actually understands it. Runs the `how` and `why` skills and weaves what they find into one clear explanation. Use for 'teach me this', 'help me really under |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/technical-writing/SKILL.md" })` | Layered technical-writing standard: Diátaxis structure, Google developer style sentences, STE instruction rules, Global English syntax. Use for /technical-writing or when writing or reviewing docs, RF |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/typescript-best-practices/SKILL.md" })` | TypeScript best practices. Use when reading or editing any .ts or .tsx file. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/unslop/SKILL.md" })` | Cut AI tells from any writing. Must always apply. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/skills/why/SKILL.md" })` | Use for 'why does X work this way', 'why we picked Y', design rationale, regressions, postmortems, or data-backed thresholds. Discovers available MCPs and queries each evidence category (source contro |

## Agents（2）→ 在 Keel 中是车道模板，不注册 agent 类型

| 路径 | 上游说明 |
|---|---|
| `ghost_manual({ ghost_id: "keel", path: "pstack/agents/comment-sicko.md" })` | A deranged comment-hater that savors deletion and condemns workaround code. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/agents/poteto-agent.md" })` | Routing target for `/poteto-mode` and any request for poteto's style. Spawn a fresh `poteto-agent` for each new task, and resume one only in the strict cases that poteto-mode's Subagents section names |

## Automations（3，上游为休眠包）

| 路径 | 上游说明 |
|---|---|
| `ghost_manual({ ghost_id: "keel", path: "pstack/automations/benny/skills/reproduce-and-fix-issues/SKILL.md" })` | Reproduce triaged Slack bugs through a configured app-control adapter, verify existing fixes, and open a bounded draft pull request only after before-and-after proof. Use only from the configured Benn |
| `ghost_manual({ ghost_id: "keel", path: "pstack/automations/benny/skills/setup-benny/SKILL.md" })` | Configure Benny and prepare its triage and repro automations. Use when installing Benny or changing its Slack, tracker, repository, routing, control, model, or budget settings. |
| `ghost_manual({ ghost_id: "keel", path: "pstack/automations/benny/skills/triage-issue-reports/SKILL.md" })` | Triage Slack issue reports with one thread-only verdict, evidence review, cause-aware routing, tracker dedupe, and fail-closed ticket creation. Use only from the configured Benny triage automation. |

各 skill 的 `references/` 与 playbook 间的相对链接保持上游目录结构，可按同样的 `pstack/<上游相对路径>` 读取（非 .md 文件追加 `.md` 后缀）。
