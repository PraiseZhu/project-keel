// J1–J12: the fixed judgement points where pstack workflows consult Jev.
// Each template turns workflow state into Typesafe questions and reads the answer back.
// Facts and gates stay in deterministic code; Jev only ranks options the policy allows.

import type { EvaluateArgs, JevAnswer, JevQuestion } from "./client.ts";
import { answerConfidence } from "./client.ts";

export const PLAYBOOKS = [
  "investigation", "bug-fix", "feature", "refactoring", "prototype", "babysit", "opening-a-pr",
  "session-pickup", "pause-safely", "worktree-cleanup", "shipping", "orchestrate", "autopilot-full",
  "autopilot-stack", "multi-phase-plan", "autonomous-run", "hillclimb", "perf-issue",
  "runtime-forensics", "trace-forensics", "visual-parity", "eval", "authoring-a-skill",
] as const;

export const SEVERITY = {
  P0: "紧急严重事故：正在发生或正常使用即可确定触发的大范围灾难性影响（严重泄露、批量不可逆数据损坏、系统性不可用），且缺乏有效隔离。",
  P1: "严重缺陷：受支持场景中存在可信、可达的触发路径，导致核心流程失效、严重数据错误或安全/隐私边界被突破。",
  P2: "一般缺陷：问题真实，但影响局部、程度有限，可能有可接受的绕行办法。",
  P3: "改进建议：无已证实功能或安全影响的风格、命名、整理、视觉润色或无收益证据的优化。",
  not_real: "不成立：与代码事实不符、触发路径不可达，或描述的行为不存在。",
} as const;

export type TemplateId = "J1" | "J2" | "J3" | "J4" | "J5" | "J6" | "J7" | "J8" | "J9" | "J10" | "J11" | "J12";

export interface Interpretation {
  readonly value: string | number | boolean;
  readonly confidence: number;
  /** For batched templates (J4/J5): one entry per item. */
  readonly items?: readonly { readonly id: string; readonly value: string; readonly confidence: number }[];
  /** Runner-up options for choice templates, best first. */
  readonly ranked?: readonly string[];
}

export interface Template {
  readonly id: TemplateId;
  readonly title: string;
  /** J7 uses the strict threshold. */
  readonly strict?: boolean;
  /** Judgement touches collateral files: Jev unavailable → stop instead of minimal. */
  readonly collateral?: boolean;
  build(state: Record<string, unknown>, options?: readonly string[]): EvaluateArgs;
  interpret(answers: Record<string, JevAnswer>): Interpretation;
  /** Option to fall back to when confidence stays low (smallest, reversible). */
  readonly minimal: string | number | boolean;
}

const choiceCriteria = (options: readonly string[], notes: Record<string, string> = {}) =>
  Object.fromEntries(options.map((o) => [o, notes[o] ?? null]));

function ranked(a: JevAnswer | undefined): string[] {
  if (!a?.probabilities) return a?.choice ? [a.choice] : [];
  return Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).map(([k]) => k);
}

function single(id: string, q: JevQuestion, state: unknown): EvaluateArgs {
  return { state, questions: { [id]: q } };
}

function readChoice(id: string) {
  return (answers: Record<string, JevAnswer>): Interpretation => {
    const a = answers[id];
    return { value: a?.choice ?? "", confidence: a ? answerConfidence(a) : 0, ranked: ranked(a) };
  };
}
function readScore(id: string) {
  return (answers: Record<string, JevAnswer>): Interpretation => {
    const a = answers[id];
    return { value: a?.score ?? 0, confidence: a ? answerConfidence(a) : 0 };
  };
}
function readNoul(id: string) {
  return (answers: Record<string, JevAnswer>): Interpretation => {
    const a = answers[id];
    return { value: (a?.noul ?? 0) >= 0.5, confidence: a ? answerConfidence(a) : 0 };
  };
}

/** Batched choice over `state.items[]` (J4/J5). Typesafe caps choice criteria, not question count; keep ≤ 40 items per call. */
export const MAX_BATCH = 40;
function batch(prefix: string, instructions: string, criteria: Record<string, unknown>) {
  return (state: Record<string, unknown>): EvaluateArgs => {
    const items = ((state.items as { id?: string }[] | undefined) ?? []).slice(0, MAX_BATCH);
    const questions: Record<string, JevQuestion> = {};
    items.forEach((_, i) => {
      questions[`${prefix}_${i}`] = { type: "choice", instructions: `${instructions}（只判断 items[${i}]）`, criteria };
    });
    if (!items.length) questions[`${prefix}_0`] = { type: "choice", instructions, criteria };
    return { state, questions };
  };
}
function readBatch(prefix: string, ids: (answers: Record<string, JevAnswer>) => string[] = () => []) {
  return (answers: Record<string, JevAnswer>): Interpretation => {
    const keys = Object.keys(answers).filter((k) => k.startsWith(prefix + "_")).sort((a, b) => Number(a.split("_").pop()) - Number(b.split("_").pop()));
    void ids;
    const items = keys.map((k) => ({ id: k, value: answers[k]?.choice ?? "", confidence: answerConfidence(answers[k]!) }));
    const confidence = items.length ? Math.min(...items.map((i) => i.confidence)) : 0;
    return { value: items.map((i) => i.value).join(","), confidence, items };
  };
}

export const TEMPLATES: Readonly<Record<TemplateId, Template>> = {
  J1: {
    id: "J1",
    title: "路由到哪个 playbook",
    build: (state) => single("playbook", {
      type: "choice",
      instructions: "这个任务应该按哪个 pstack playbook 执行？只看任务描述与给出的上下文。纯问答、改一个错字这类不需要流程的任务选 trivial_no_pstack；没有合适 playbook 时选 figure-it-out。",
      criteria: choiceCriteria([...PLAYBOOKS, "figure-it-out", "trivial_no_pstack"]),
    }, state),
    interpret: readChoice("playbook"),
    minimal: "figure-it-out",
  },
  J2: {
    id: "J2",
    title: "任务深度",
    build: (state) => single("depth", {
      type: "score",
      instructions: "这个任务的实现深度有多大？",
      criteria: ["0 琐碎：不改行为", "1 单文件", "2 跨函数", "3 跨模块", "4 架构级"],
    }, state),
    interpret: readScore("depth"),
    minimal: 1,
  },
  J3: {
    id: "J3",
    title: "arena 选哪个候选做基础",
    build: (state, options) => single("base", {
      type: "choice",
      instructions: "这些候选实现里，哪一个最适合作为基础再嫁接其他候选的优点？看正确性、改动最小、与仓内写法一致。",
      criteria: choiceCriteria(options ?? ((state.candidates as { label: string }[] | undefined) ?? []).map((c) => c.label)),
    }, state),
    interpret: readChoice("base"),
    minimal: "",
  },
  J4: {
    id: "J4",
    title: "审查发现统一分级",
    build: batch("sev", "按统一分级判断这条审查发现的实际影响等级。来源标签、工具评分、重复次数都不能单独决定等级。", choiceCriteria(Object.keys(SEVERITY), SEVERITY)),
    interpret: readBatch("sev"),
    minimal: "P2",
  },
  J5: {
    id: "J5",
    title: "机器人评论处理",
    build: batch("bot", "这条机器人评审评论应该如何处理？dismiss 需要能给出具体反证；涉及安全、数据或权限一律 ask。", choiceCriteria(["fix", "dismiss", "ask"], {
      fix: "评论成立，应修改代码",
      dismiss: "评论不成立，且能给出具体反证",
      ask: "无法确定，或涉及安全/数据/权限，交给人判断",
    })),
    interpret: readBatch("bot"),
    minimal: "ask",
  },
  J6: {
    id: "J6",
    title: "CI 红的性质",
    build: (state) => single("ci", {
      type: "choice",
      instructions: "这次 CI 失败最可能是什么性质？依据失败日志摘要、改动文件与基线信息判断。",
      criteria: choiceCriteria(["infra_flake", "stale_base", "regression", "stale_assertion"], {
        infra_flake: "基础设施抖动，重跑大概率通过",
        stale_base: "基线过旧，rebase 到最新 base 后再看",
        regression: "本 diff 引入的回归",
        stale_assertion: "旧断言与已批准的新行为不符",
      }),
    }, state),
    interpret: readChoice("ci"),
    minimal: "regression",
  },
  J7: {
    id: "J7",
    title: "域外旧测试：更新断言还是真回归",
    strict: true,
    collateral: true,
    build: (state) => single("legacy", {
      type: "choice",
      instructions: "这条失败的旧测试，是旧断言需要按已批准的新行为更新，还是本改动造成了真回归？只有测试文件可改。",
      criteria: choiceCriteria(["update_assertion", "real_regression"]),
    }, state),
    interpret: readChoice("legacy"),
    minimal: "real_regression",
  },
  J8: {
    id: "J8",
    title: "PR 下一步",
    build: (state, options) => single("next", {
      type: "choice",
      instructions: "在允许的动作中，这个 PR 下一步最该做什么？",
      criteria: choiceCriteria(options ?? ((state.allowed_actions as string[] | undefined) ?? [])),
    }, state),
    interpret: readChoice("next"),
    minimal: "",
  },
  J9: {
    id: "J9",
    title: "完成证据是否充分",
    build: (state) => single("evidence", {
      type: "score",
      instructions: "给出的证据能否证明改动真的在目标路径上工作（prove-it-works）？只凭编译或类型检查通过不算运行证据。",
      criteria: ["0 没有运行证据", "1 只有静态检查", "2 有部分运行证据但未覆盖目标路径", "3 目标路径有运行证据", "4 目标路径与回归路径都有运行证据"],
    }, state),
    interpret: readScore("evidence"),
    minimal: 0,
  },
  J10: {
    id: "J10",
    title: "实现是否存在多种合理形态",
    build: (state) => single("multi_shape", { type: "noul", instructions: "这个功能是否存在两种以上都合理、且差异显著的实现形态，值得并行做候选再比较？" }, state),
    interpret: readNoul("multi_shape"),
    minimal: false,
  },
  J11: {
    id: "J11",
    title: "连续失败的修复是否共享同一前提",
    build: (state) => single("premise", { type: "noul", instructions: "这几次失败的修复，是否都建立在同一个可能错误的前提上（attack-the-premise）？" }, state),
    interpret: readNoul("premise"),
    minimal: true,
  },
  J12: {
    id: "J12",
    title: "影响面是否需要更多运行证据",
    build: (state) => single("blast", { type: "noul", instructions: "按改动的影响面（blast radius），现有运行证据是否还不够，需要补跑更多真实路径？" }, state),
    interpret: readNoul("blast"),
    minimal: true,
  },
};

export function template(id: string): Template | null {
  return (TEMPLATES as Record<string, Template>)[id] ?? null;
}
