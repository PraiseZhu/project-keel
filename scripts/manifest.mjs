// Generates plugin/ghost.json. Tool contracts live here (one place), not hand-edited JSON.
import { writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const int = (description, extra = {}) => ({ type: "integer", description, ...extra });
const bool = (description) => ({ type: "boolean", description });
const obj = (properties, required = []) => ({ type: "object", additionalProperties: false, properties, ...(required.length ? { required } : {}) });
const prRef = {
  repo_dir: str("本地仓库目录（绝对路径）。缺省时需给 repo。"),
  repo: str("GitHub 仓库 owner/name。"),
  pr: int("PR 编号；缺省取 repo_dir 当前分支的 PR。"),
  run_id: str("可选：pstack_start 返回的 run_id，用于写台账。"),
};
const question = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: ["choice", "score", "noul"] },
    instructions: { type: ["string", "object", "array"], description: "明确的判断问题。" },
    criteria: { type: ["object", "array"], description: "choice: 选项名到说明/null 的对象，1–255 项。score: 从低到高的 2–10 个等级说明数组。noul: 可省略，或 true/false 说明对象。" },
  },
  required: ["type", "instructions"],
};

const tools = [
  {
    name: "jev",
    description: "日常 Jev 快速判断（Typesafe）：分类/选项选择、评分、是非概率。不读写仓库、不启动本地进程；联网目标 api.typesafe.ai；只在插件私有数据目录写一行判断留痕。两种入参二选一：①与旧 typesafe-jev evaluate 完全相同的 {state, questions, model?}；②简写 {question, kind, options?/levels?, context?}。list_models:true 查询可用模型。结果是模型估计，不是事实；confidence_hint 只提示是否达 0.75 执行线。",
    parameters: obj({
      state: { type: ["string", "object", "array"], description: "待判断文本或 JSON 数据（形式①）。" },
      questions: { type: "object", minProperties: 1, additionalProperties: question, description: "问题表（形式①）。" },
      model: str("默认 jev-latest；可指定官方版本 ID。"),
      question: str("一句话问题（形式②）。"),
      kind: { type: "string", enum: ["choice", "score", "yesno"], description: "形式②的题型。" },
      options: { type: "array", items: { type: "string" }, description: "kind=choice 的选项。" },
      levels: { type: "array", items: { type: "string" }, description: "kind=score 的等级（低→高），缺省 低/中/高。" },
      context: { type: ["string", "object", "array"], description: "形式②的判断材料；缺省用 question 本身。" },
      list_models: bool("true 时只返回可用模型列表。"),
    }),
  },
  {
    name: "pstack_start",
    description: "开始一次 pstack 工作流：用 Jev（J1 路由 + J2 深度）选 playbook，返回 run_id、playbook、手册路径、步骤、深度与 architect/arena 建议。Jev 不可用时退回关键词路由，不报错。只读：可能在 repo_dir 读 git 状态；联网 api.typesafe.ai；在插件私有数据目录写台账。跨多个 PR 的任务会返回“交给 task-priority → approve-exec”的指引。",
    parameters: obj({ task: str("用户的任务原话。"), repo_dir: str("可选：目标仓库目录。"), repo: str("可选：owner/name，用于判断车道。"), playbook: str("用户点名的 playbook，跳过 J1。"), context: str("可选：补充上下文。") }, ["task"]),
  },
  {
    name: "pstack_decide",
    description: "在 pstack 固定判断点调用 Jev（模板 J1–J12），按阈值策略返回 act/reask/minimal/stop 并写台账。J7 用 0.8 执行线，其余 0.75。通用问答请用 jev。联网 api.typesafe.ai；写插件私有数据目录。",
    parameters: obj({ template: { type: "string", enum: ["J1", "J2", "J3", "J4", "J5", "J6", "J7", "J8", "J9", "J10", "J11", "J12"] }, state: { type: ["object", "string"], description: "判断所需的事实（只给相关内容）。" }, options: { type: "array", items: { type: "string" }, description: "J3/J8 的候选或允许动作。" }, run_id: str("可选：台账 run_id。"), reasked: bool("已补充上下文重问过一次时传 true。") }, ["template", "state"]),
  },
  {
    name: "pstack_ledger",
    description: "读写 pstack 运行台账（插件私有数据目录）。log 追加一行 decision/step/evidence/gap；read 读取某次或最近的运行。不联网、不碰仓库。",
    parameters: obj({ op: { type: "string", enum: ["log", "read"] }, run_id: str("run_id；read 时可省略取最近。"), kind: { type: "string", enum: ["decision", "step", "evidence", "gap"] }, summary: str("一句话摘要。"), evidence: { type: ["object", "string", "array"], description: "证据（命令、SHA、链接）。" }, limit: int("read 返回行数上限。") }, ["op"]),
  },
  {
    name: "pr_status",
    description: "读取 PR 状态（只读，调用本机 gh/git 访问 GitHub）：车道、上游 watch-pr 判定（冲突→评审线程→CI→合并闸→等待→可合并）、Ready 门禁、允许动作与下一步（Jev J8/J6 只在允许动作内排序）。可合并时只返回链接，插件不提供合并。",
    parameters: obj(prRef),
  },
  {
    name: "pr_wait",
    description: "等待 PR 到 CI 终态或发生变化（只读）：每 ≥30 秒用本机 gh 读一次快照，期间发心跳；最长 25 分钟，超时返回 TIMEOUT 与最后快照。",
    parameters: obj({ ...prRef, until: { type: "string", enum: ["ci_terminal", "change"] }, max_minutes: int("最长等待分钟（≤25，缺省 20）。") }),
  },
  {
    name: "pr_open",
    description: "用本机 gh 开 PR（会写 GitHub）。push:true 时先 git push 当前分支。需要 authorization_source（用户授权原话）。车道规则：Draft 优先车道强制 Draft；其余默认非 Draft；标题类型按 base 分支规则文件校验。不会合并。",
    parameters: obj({ repo_dir: str("本地仓库目录。"), title: str("PR 标题。"), sections: { type: ["object", "string"], description: "正文：{段名: 内容} 或整段 Markdown。" }, base: str("目标分支，缺省为默认分支。"), draft: bool("是否 Draft（Draft 优先车道忽略 false）。"), push: bool("开 PR 前推送当前分支。"), authorization_source: str("用户授权这次动作的原话与日期。"), run_id: str("可选台账 run_id。") }, ["repo_dir", "title", "sections", "authorization_source"]),
  },
  {
    name: "pr_ready",
    description: "评估并（非 dry_run 时）把 Draft PR 转为 Ready（会写 GitHub）。门禁车道要求当前 head 的必需检查非空且全部通过，否则返回 GATE_NOT_MET 与缺项；交接车道转 Ready 后写交接记录，之后推送/回帖类调用返回 LANE_HANDED_OFF。dry_run:true 只评估门禁，绝不执行 gh pr ready。非 dry_run 需要 authorization_source。",
    parameters: obj({ ...prRef, dry_run: bool("只评估门禁。"), authorization_source: str("用户授权原话与日期（非 dry_run 必填）。") }),
  },
  {
    name: "pr_threads",
    description: "列出 PR 未解决的评审线程（只读，本机 gh），并用 Jev 批量做统一分级（J4：P0/P1/P2/P3/不成立）与机器人评论处理建议（J5：fix/dismiss/ask）。只有确认成立的 P0/P1 进入修复清单。",
    parameters: obj(prRef),
  },
  {
    name: "pr_reply",
    description: "在 PR 评审线程或主讨论区发表回复（会写 GitHub，对外可见）。每次都先弹确认框让用户亲自确认正文；用户取消返回 USER_DECLINED。交接后的 PR 返回 LANE_HANDED_OFF。",
    parameters: obj({ ...prRef, target_id: str("评审线程 id（PRRT_ 开头），或 \"issue\" 表示主讨论区。"), body: str("回复正文。"), resolve: bool("回复后标记线程已解决。") }, ["target_id", "body"]),
  },
  {
    name: "pr_board",
    description: "刷新“我名下 open PR”看板（只读，本机 gh）：每个 PR 的车道、判定、下一步；更新面板与未读角标，写插件私有数据目录。可合并的 PR 只显示“可合并”和链接。",
    parameters: obj({ repos: { type: "array", items: { type: "string" }, description: "限定 owner/name 列表；缺省用本机配置。" } }),
  },
  {
    name: "worktree",
    description: "管理 <仓>/.worktrees/ 下的 git worktree（本机 git）。create 新建；audit 只读分类（hold-wip/hold-open-pr/review/safe）；prune 只删审计为 safe（干净且已合并）的行，删除前弹确认列出路径，不用 --force。",
    parameters: obj({ op: { type: "string", enum: ["create", "audit", "prune"] }, repo_dir: str("仓库目录。"), name: str("create：worktree 名。"), base_ref: str("create：起点，缺省 origin/默认分支。"), paths: { type: "array", items: { type: "string" }, description: "prune：要删的路径；缺省为全部 safe 行。" } }, ["op", "repo_dir"]),
  },
  {
    name: "roles",
    description: "现读本机 Orca routing.json，返回 developer/reviewer/tester/merger 对应的 {agent, model, effort, provider_id, fallbacks} 与来源档位。读不到或格式错返回 ROUTING_UNREADABLE（fail-closed，不自行换模型）。只读本地文件。",
    parameters: obj({ op: { type: "string", enum: ["show", "refresh"] }, lead_model: str("当前 lead 会话模型 id；gpt 系会改用 review.when_lead.gpt。") }),
  },
  {
    name: "fanout_plan",
    description: "规划多模型并行（arena/interrogate/swarm）：现读 routing.json 生成每条车道的派工参数（create_workers 可直接用），写车道由本机 git 预建 <仓>/.worktrees/pstack-<id>-<label>/。不派发 Worker——派发由主 Agent 执行。",
    parameters: obj({ kind: { type: "string", enum: ["arena", "interrogate", "swarm"] }, run_id: str("台账 run_id。"), repo_dir: str("仓库目录。"), base_ref: str("写车道起点。"), task: str("任务描述。"), rubric: str("评审标准。"), lanes: int("车道数（arena/interrogate 缺省 3）。"), slices: { type: "array", items: { type: "string" }, description: "swarm 的切片。" }, lead_model: str("lead 会话模型 id。") }, ["kind", "task"]),
  },
  {
    name: "fanout_ingest",
    description: "汇收并行车道结果：arena 收各 worktree diff 并用 Jev J3 选基础；interrogate 解析审查 JSON、去重后 J4 分级，输出共识/单模型/分歧；swarm 输出 PASS/ISSUES/BLOCKED 与缺口。cleanup:true 只清本次 fanout 的干净 worktree。",
    parameters: obj({ fanout_id: str("fanout_plan 返回的 id。"), kind: { type: "string", enum: ["arena", "interrogate", "swarm"] }, repo_dir: str("仓库目录。"), lane_results: { type: "array", items: { type: "object" }, description: "每条车道的 {label, text?, verdict?}。" }, cleanup: bool("汇收后清理本次 worktree。"), run_id: str("台账 run_id。") }, ["fanout_id", "kind"]),
  },
];

const manifest = {
  schemaVersion: 3,
  minCindyVersion: "0.1.97",
  id: "keel",
  name: "Keel 龙骨",
  description: "日常随时可问的 Jev 快速判断，加上完整复刻 pstack 的 PR 推进与修 bug 工作流（内嵌 Jev）。",
  whenToUse: "用户要问 Jev 做选择、评分或是非判断；或要推进 PR、盯 CI 与评审、修 bug、按 pstack 方法做调查/重构/功能，以及清理 worktree、查派工角色时使用。",
  version: pkg.version,
  kind: "chip",
  entry: "main.js",
  icon: "assets/icon.png",
  command: "keel",
  launch: "on-demand",
  tools,
  node: { entry: "node/worker.cjs", protocol: "json-rpc-stdio", lifecycle: "on-demand", idleTimeoutSeconds: 300 },
  network: {
    hosts: ["api.typesafe.ai"],
    secrets: [{ key: "api_key", label: "Typesafe API Key", source: "user", url: "https://console.typesafe.ai/home", inject: { header: "Authorization", format: "Bearer {value}", hosts: ["api.typesafe.ai"] } }],
  },
  settingsHtml: "settings.html",
  // The Typesafe key is optional: without it Jev-backed judgements fall back to deterministic
  // rules and `jev` reports JEV_NOT_CONFIGURED. Without this, the host's heuristic blocks every
  // tool behind the setup card until a key is saved.
  setup: { requires: [] },
  panel: { title: "Keel 龙骨", html: "panel.html" },
  badge: true,
  confirm: true,
  fs: true,
  agent: { schedule: true },
  manual: {
    items: [
      { dir: "manual/keel", name: "keel", description: "中文入口：工具地图、车道、用户规则覆盖层、Cursor→Cindy 对照、并行派工协议。" },
      { dir: "manual/pstack", name: "pstack", description: "pstack 上游镜像（skills / playbooks / agents / references），按 MANUAL.md 路由表读取。" },
      { dir: "manual/jev", name: "jev", description: "日常 Jev 用法、问题写法与阈值含义。" },
    ],
  },
};
writeFileSync(join(root, "plugin/ghost.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`ghost.json: ${tools.length} tools`);
