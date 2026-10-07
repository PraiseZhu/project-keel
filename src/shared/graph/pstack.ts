// Compile pstack playbooks into fixed GraphSpec instances.
// Data only: no interpreter, no dispatch. Playbook originals stay untouched.

import {
  type Adaptation,
  type EdgeOn,
  type GraphEdge,
  type GraphNode,
  type GraphSpec,
  type NodeKind,
  type NodeRole,
  type NodeWhen,
} from "./spec.ts";

export const GRAPH_VERSION = 1;
export const TASK_TYPES = ["bug-fix", "feature", "refactoring", "investigation", "pr"] as const;
export type GraphTaskType = (typeof TASK_TYPES)[number];

const PR_TAIL_COVERS = ["opening-a-pr", "babysit", "shipping", "autonomous-run"] as const;

type NodeInit = {
  kind: NodeKind;
  writes: boolean;
  timebox_min: number;
  max_attempts: number;
  playbook_steps?: readonly string[];
  role?: NodeRole;
  when?: NodeWhen;
};

function node(id: string, init: NodeInit): GraphNode {
  return {
    id,
    kind: init.kind,
    writes: init.writes,
    playbook_steps: [...(init.playbook_steps ?? [])],
    timebox_min: init.timebox_min,
    max_attempts: init.max_attempts,
    ...(init.role ? { role: init.role } : {}),
    ...(init.when ? { when: init.when } : {}),
  };
}

function edge(from: string, to: string, on: EdgeOn = "ok"): GraphEdge {
  return { from, to, on };
}

const TERMINALS: GraphNode[] = [
  node("done", { kind: "tool", writes: false, timebox_min: 1, max_attempts: 1, playbook_steps: ["shipping#9", "babysit#9"] }),
  node("stopped", { kind: "tool", writes: false, timebox_min: 1, max_attempts: 1 }),
];

const INVESTIGATION_TERMINALS: GraphNode[] = [
  node("done", { kind: "tool", writes: false, timebox_min: 1, max_attempts: 1, playbook_steps: ["investigation#3"] }),
  node("stopped", { kind: "tool", writes: false, timebox_min: 1, max_attempts: 1 }),
];

/** Shared PR-tail adaptations (F09: record rebase / stack / merge rewrites explicitly). */
export const PR_TAIL_ADAPTATIONS: Adaptation[] = [
  {
    playbook_step: "opening-a-pr",
    kind: "equivalent_handoff",
    reason: "原文无编号步骤；Keel 改写后整篇等价转交 open-pr 工具节点（pr_open）。禁止 rebase / force-push；Draft 跟车道走。",
  },
  {
    playbook_step: "babysit#1",
    kind: "user_goal_override",
    reason: "图编排把 babysit 固定为 drive 等价循环（冲突→线程→CI）；mode / forge 解析不另开节点，由 wait-ci 工具承担。",
  },
  {
    playbook_step: "babysit#2",
    kind: "user_goal_override",
    reason: "v1 每个 run 只推进一个 PR，merge frontier 就是该 PR；不建多 PR 队列节点。",
  },
  {
    playbook_step: "babysit#3",
    kind: "equivalent_handoff",
    reason: "一个 run 独占该 PR，等价于 one babysitter per stack。",
  },
  {
    playbook_step: "babysit#4",
    kind: "user_goal_override",
    reason: "KEEL 禁止 rebase、force-push 与改 stack topology；冲突开人工门交用户，不在 babysit 内 rebase。",
  },
  {
    playbook_step: "shipping#2",
    kind: "user_goal_override",
    reason: "v1 单 PR，contiguous verified run 就是当前 PR；报告可合并即 ceiling。",
  },
  {
    playbook_step: "shipping#4",
    kind: "user_goal_override",
    reason: "KEEL 禁止 rebase / retarget；不把分支 rebase 到 trunk，只复核当前 head。",
  },
  {
    playbook_step: "shipping#6",
    kind: "not_applicable",
    reason: "KEEL 无合并能力，不读取 autoMergeRequest 作为就绪信号。",
  },
  {
    playbook_step: "shipping#7",
    kind: "not_applicable",
    reason: "用户在 GitHub 合并；v1 单 PR 不在图内复算下一 PR。",
  },
  {
    playbook_step: "shipping#8",
    kind: "user_goal_override",
    reason: "KEEL 不合并、不盯到 merged；report-ready 后进入 done。Watch-until-merge 由用户在 GitHub 完成。",
  },
  {
    playbook_step: "autonomous-run#1",
    kind: "equivalent_handoff",
    reason: "exit condition 由 keel_run 的 SC 与图 done 条件承担，不另建节点。",
  },
  {
    playbook_step: "autonomous-run#2",
    kind: "equivalent_handoff",
    reason: "wake 机制由后续解释器的 keel_wait / 时钟承担；本 PR 只固定 wait-ci 节点。",
  },
  {
    playbook_step: "autonomous-run#3",
    kind: "equivalent_handoff",
    reason: "最小证据改动由 implement / fix-ci Worker 节点执行。",
  },
  {
    playbook_step: "autonomous-run#4",
    kind: "equivalent_handoff",
    reason: "中途发现经 G-retry 升级；同一失败指纹出现 2 次时从失败边插入 astra-unstick。",
  },
  {
    playbook_step: "autonomous-run#5",
    kind: "equivalent_handoff",
    reason: "每轮 checkpoint 由后续 graph-state 记录；本 PR 不做解释器。",
  },
];

export const BUG_FIX_ADAPTATIONS: Adaptation[] = [
  {
    playbook_step: "bug-fix#1",
    kind: "equivalent_handoff",
    reason: "主控不写代码，所以复现交给 Worker（Orca，worktree）；仅在控制面无法到达目标时才问用户。",
  },
];

export const FEATURE_ADAPTATIONS: Adaptation[] = [
  {
    playbook_step: "feature#3",
    kind: "equivalent_handoff",
    reason: "throughput checkpoint 四项待办不丢，转为 G-arena 门节点；不适用维度由 Worker 在报告里写 n/a:<reason>。",
  },
  {
    playbook_step: "feature#6",
    kind: "user_goal_override",
    reason: "KEEL 禁止 rebase 与 force-push；原文“Rebase into small, ordered commits”改为提交整理由 Worker 在 worktree 内完成（implement 节点），不 force-push。",
  },
];

export const REFACTORING_ADAPTATIONS: Adaptation[] = [
  {
    playbook_step: "refactoring#8",
    kind: "user_goal_override",
    reason: "KEEL 禁止 rebase 与 force-push；原文 rebase 小步提交改为 Worker 在 worktree 内整理提交，然后转交 open-pr。不 force-push。",
  },
];

export const INVESTIGATION_ADAPTATIONS: Adaptation[] = [
  {
    playbook_step: "investigation#2",
    kind: "not_applicable",
    reason: "原文即 “throughput checkpoint: n/a, read-only investigation”；不建吞吐检查点 / G-arena 节点。",
  },
  {
    playbook_step: "investigation#4",
    kind: "equivalent_handoff",
    reason: "unslop 在 report 节点内由主控交回前执行；investigation 不派 Architect、不接 PR 尾段。",
  },
];

function retryGate(id: string, resume: string, escalateTo: string): { nodes: GraphNode[]; edges: GraphEdge[] } {
  return {
    nodes: [node(id, { kind: "gate", writes: false, timebox_min: 5, max_attempts: 3, playbook_steps: ["autonomous-run#4"] })],
    edges: [
      edge(id, resume, "gate:retry"),
      edge(id, escalateTo, "gate:escalate"),
      edge(id, "stopped", "gate:stop"),
    ],
  };
}

function prTail(opts: { reviseTo: string; unstickTo: string }): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const retryFix = retryGate("g-retry-fix-ci", "fix-ci", "astra-unstick");
  const retryThreads = retryGate("g-retry-threads", "triage-threads", "astra-unstick");
  const retryVerify = retryGate("g-retry-verify", "verify-head", "astra-unstick");
  return {
    nodes: [
      node("open-pr", {
        kind: "tool",
        writes: false,
        timebox_min: 15,
        max_attempts: 2,
        playbook_steps: ["opening-a-pr", "bug-fix#6", "feature#8", "refactoring#8"],
      }),
      node("wait-ci", {
        kind: "tool",
        writes: false,
        timebox_min: 25,
        max_attempts: 8,
        playbook_steps: ["babysit#5", "babysit#6"],
      }),
      node("conflict-human", {
        kind: "human",
        writes: false,
        timebox_min: 240,
        max_attempts: 3,
        playbook_steps: ["babysit#5"],
      }),
      node("triage-threads", {
        kind: "dispatch",
        role: "worker",
        writes: true,
        timebox_min: 45,
        max_attempts: 3,
        playbook_steps: ["babysit#5", "babysit#8"],
      }),
      node("ci-rerun-once", {
        kind: "tool",
        writes: false,
        timebox_min: 25,
        max_attempts: 1,
        playbook_steps: ["babysit#7"],
      }),
      node("fix-ci", {
        kind: "dispatch",
        role: "worker",
        writes: true,
        timebox_min: 45,
        max_attempts: 3,
        playbook_steps: ["babysit#7"],
      }),
      node("astra-unstick", {
        kind: "dispatch",
        role: "architect",
        writes: false,
        timebox_min: 40,
        max_attempts: 2,
        playbook_steps: ["autonomous-run#6"],
        when: { kind: "fingerprint_repeat", times: 2 },
      }),
      node("astra-final-review", {
        kind: "dispatch",
        role: "architect",
        writes: false,
        timebox_min: 40,
        max_attempts: 2,
        playbook_steps: ["shipping#1"],
      }),
      node("g-accept", {
        kind: "gate",
        writes: false,
        timebox_min: 5,
        max_attempts: 3,
        playbook_steps: ["shipping#1"],
      }),
      node("human-accept", {
        kind: "human",
        writes: false,
        timebox_min: 240,
        max_attempts: 3,
      }),
      node("verify-head", {
        kind: "dispatch",
        role: "verifier",
        writes: false,
        timebox_min: 40,
        max_attempts: 3,
        playbook_steps: ["shipping#1", "shipping#3"],
      }),
      node("report-ready", {
        kind: "tool",
        writes: false,
        timebox_min: 15,
        max_attempts: 2,
        playbook_steps: ["shipping#5", "babysit#9"],
      }),
      ...retryFix.nodes,
      ...retryThreads.nodes,
      ...retryVerify.nodes,
      ...TERMINALS,
    ],
    edges: [
      edge("open-pr", "wait-ci"),
      edge("open-pr", "stopped", "fail"),
      edge("wait-ci", "astra-final-review"),
      edge("wait-ci", "conflict-human", "conflict"),
      edge("wait-ci", "triage-threads", "threads"),
      edge("wait-ci", "ci-rerun-once", "ci_red"),
      edge("conflict-human", "wait-ci"),
      edge("conflict-human", "stopped", "fail"),
      edge("triage-threads", "wait-ci"),
      edge("triage-threads", "g-retry-threads", "fail"),
      edge("triage-threads", "astra-unstick", "fingerprint_repeat"),
      ...retryThreads.edges,
      edge("ci-rerun-once", "wait-ci"),
      edge("ci-rerun-once", "fix-ci", "fail"),
      edge("fix-ci", "wait-ci"),
      edge("fix-ci", "g-retry-fix-ci", "fail"),
      edge("fix-ci", "astra-unstick", "fingerprint_repeat"),
      ...retryFix.edges,
      edge("astra-unstick", opts.unstickTo),
      edge("astra-unstick", "stopped", "fail"),
      edge("astra-final-review", "g-accept"),
      edge("astra-final-review", "stopped", "fail"),
      edge("g-accept", "verify-head", "gate:adopt"),
      edge("g-accept", opts.reviseTo, "gate:revise"),
      edge("g-accept", "human-accept", "gate:ask_user"),
      edge("human-accept", "verify-head"),
      edge("human-accept", "stopped", "fail"),
      edge("verify-head", "report-ready"),
      edge("verify-head", "verify-head", "head_moved"),
      edge("verify-head", "g-retry-verify", "fail"),
      ...retryVerify.edges,
      edge("report-ready", "done"),
      edge("report-ready", "stopped", "fail"),
    ],
  };
}

function spec(id: GraphTaskType, covers: readonly string[], entry: string, nodes: GraphNode[], edges: GraphEdge[], adaptations: Adaptation[]): GraphSpec {
  return { id, version: GRAPH_VERSION, nodes, edges, entry, exits: ["done", "stopped"], covers, adaptations };
}

function assemble(id: GraphTaskType, covers: readonly string[], entry: string, unit: { nodes: GraphNode[]; edges: GraphEdge[] }, tail: { nodes: GraphNode[]; edges: GraphEdge[] }, extra: Adaptation[]): GraphSpec {
  return spec(id, covers, entry, [...unit.nodes, ...tail.nodes], [...unit.edges, ...tail.edges], [...extra, ...PR_TAIL_ADAPTATIONS]);
}

function bugFixGraph(): GraphSpec {
  const retryRepro = retryGate("g-retry-reproduce", "reproduce", "astra-unstick");
  const retryImpl = retryGate("g-retry-implement", "implement", "astra-unstick");
  const unit = {
    nodes: [
      node("reproduce", {
        kind: "dispatch",
        role: "worker",
        writes: true,
        timebox_min: 30,
        max_attempts: 3,
        playbook_steps: ["bug-fix#1"],
      }),
      node("explore", {
        kind: "dispatch",
        role: "explorer",
        writes: false,
        timebox_min: 20,
        max_attempts: 3,
        playbook_steps: ["bug-fix#2"],
      }),
      node("research", {
        kind: "plugin_task",
        role: "researcher",
        writes: false,
        timebox_min: 25,
        max_attempts: 3,
        playbook_steps: ["bug-fix#2"],
      }),
      node("g-advance-mechanism", {
        kind: "gate",
        writes: false,
        timebox_min: 5,
        max_attempts: 3,
        playbook_steps: ["bug-fix#2"],
      }),
      node("architect-plan", {
        kind: "dispatch",
        role: "architect",
        writes: false,
        timebox_min: 40,
        max_attempts: 2,
        playbook_steps: ["bug-fix#3"],
        when: { kind: "crosses_function_boundary" },
      }),
      node("implement", {
        kind: "dispatch",
        role: "worker",
        writes: true,
        timebox_min: 60,
        max_attempts: 3,
        playbook_steps: ["bug-fix#3", "bug-fix#5"],
      }),
      node("verify-same-surface", {
        kind: "dispatch",
        role: "worker",
        writes: true,
        timebox_min: 30,
        max_attempts: 3,
        playbook_steps: ["bug-fix#4"],
      }),
      node("g-advance-verify", {
        kind: "gate",
        writes: false,
        timebox_min: 5,
        max_attempts: 3,
        playbook_steps: ["bug-fix#4"],
      }),
      ...retryRepro.nodes,
      ...retryImpl.nodes,
    ],
    edges: [
      edge("reproduce", "explore"),
      edge("reproduce", "g-retry-reproduce", "fail"),
      edge("reproduce", "astra-unstick", "fingerprint_repeat"),
      ...retryRepro.edges,
      edge("explore", "research"),
      edge("explore", "stopped", "fail"),
      edge("research", "g-advance-mechanism"),
      edge("research", "stopped", "fail"),
      edge("g-advance-mechanism", "architect-plan", "gate:advance"),
      edge("g-advance-mechanism", "explore", "gate:stay"),
      edge("architect-plan", "implement"),
      edge("architect-plan", "stopped", "fail"),
      edge("implement", "verify-same-surface"),
      edge("implement", "g-retry-implement", "fail"),
      edge("implement", "astra-unstick", "fingerprint_repeat"),
      ...retryImpl.edges,
      edge("verify-same-surface", "g-advance-verify"),
      edge("verify-same-surface", "implement", "fail"),
      edge("g-advance-verify", "open-pr", "gate:advance"),
      edge("g-advance-verify", "verify-same-surface", "gate:stay"),
    ],
  };
  return assemble("bug-fix", ["bug-fix", ...PR_TAIL_COVERS], "reproduce", unit, prTail({ reviseTo: "implement", unstickTo: "implement" }), BUG_FIX_ADAPTATIONS);
}

function featureGraph(): GraphSpec {
  const retryImpl = retryGate("g-retry-implement", "implement", "astra-unstick");
  const retryArena = retryGate("g-retry-arena", "arena", "astra-unstick");
  const unit = {
    nodes: [
      node("explore", {
        kind: "dispatch",
        role: "explorer",
        writes: false,
        timebox_min: 20,
        max_attempts: 3,
        playbook_steps: ["feature#1"],
      }),
      node("architect-plan", {
        kind: "dispatch",
        role: "architect",
        writes: false,
        timebox_min: 40,
        max_attempts: 2,
        playbook_steps: ["feature#2"],
        when: { kind: "always" },
      }),
      node("g-arena", {
        kind: "gate",
        writes: false,
        timebox_min: 5,
        max_attempts: 3,
        playbook_steps: ["feature#3"],
      }),
      node("implement", {
        kind: "dispatch",
        role: "worker",
        writes: true,
        timebox_min: 60,
        max_attempts: 3,
        playbook_steps: ["feature#4", "feature#6"],
      }),
      node("arena", {
        kind: "dispatch",
        role: "worker",
        writes: true,
        timebox_min: 60,
        max_attempts: 3,
        playbook_steps: ["feature#4"],
      }),
      node("g-accept-arena", {
        kind: "gate",
        writes: false,
        timebox_min: 5,
        max_attempts: 3,
        playbook_steps: ["feature#4"],
      }),
      node("human-arena", {
        kind: "human",
        writes: false,
        timebox_min: 240,
        max_attempts: 3,
      }),
      node("verify-same-surface", {
        kind: "dispatch",
        role: "worker",
        writes: true,
        timebox_min: 30,
        max_attempts: 3,
        playbook_steps: ["feature#5"],
      }),
      node("g-advance-verify", {
        kind: "gate",
        writes: false,
        timebox_min: 5,
        max_attempts: 3,
        playbook_steps: ["feature#5"],
      }),
      node("interrogate", {
        kind: "dispatch",
        role: "verifier",
        writes: false,
        timebox_min: 40,
        max_attempts: 2,
        playbook_steps: ["feature#7"],
        when: { kind: "design_contested" },
      }),
      node("interrogate-architect", {
        kind: "dispatch",
        role: "architect",
        writes: false,
        timebox_min: 40,
        max_attempts: 2,
        playbook_steps: ["feature#7"],
        when: { kind: "design_contested" },
      }),
      ...retryImpl.nodes,
      ...retryArena.nodes,
    ],
    edges: [
      edge("explore", "architect-plan"),
      edge("explore", "stopped", "fail"),
      edge("architect-plan", "g-arena"),
      edge("architect-plan", "stopped", "fail"),
      edge("g-arena", "implement", "gate:single"),
      edge("g-arena", "arena", "gate:arena"),
      edge("implement", "verify-same-surface"),
      edge("implement", "g-retry-implement", "fail"),
      edge("implement", "astra-unstick", "fingerprint_repeat"),
      ...retryImpl.edges,
      edge("arena", "g-accept-arena"),
      edge("arena", "g-retry-arena", "fail"),
      edge("arena", "astra-unstick", "fingerprint_repeat"),
      ...retryArena.edges,
      edge("g-accept-arena", "verify-same-surface", "gate:adopt"),
      edge("g-accept-arena", "arena", "gate:revise"),
      edge("g-accept-arena", "human-arena", "gate:ask_user"),
      edge("human-arena", "verify-same-surface"),
      edge("human-arena", "stopped", "fail"),
      edge("verify-same-surface", "g-advance-verify"),
      edge("verify-same-surface", "implement", "fail"),
      edge("g-advance-verify", "interrogate", "gate:advance"),
      edge("g-advance-verify", "verify-same-surface", "gate:stay"),
      edge("interrogate", "interrogate-architect"),
      edge("interrogate", "stopped", "fail"),
      edge("interrogate-architect", "open-pr"),
      edge("interrogate-architect", "stopped", "fail"),
    ],
  };
  return assemble("feature", ["feature", ...PR_TAIL_COVERS], "explore", unit, prTail({ reviseTo: "implement", unstickTo: "implement" }), FEATURE_ADAPTATIONS);
}

function refactoringGraph(): GraphSpec {
  const retryImpl = retryGate("g-retry-implement", "implement", "astra-unstick");
  const retryPin = retryGate("g-retry-pin", "pin-test", "astra-unstick");
  const unit = {
    nodes: [
      node("pin-explore", {
        kind: "dispatch",
        role: "explorer",
        writes: false,
        timebox_min: 20,
        max_attempts: 3,
        playbook_steps: ["refactoring#1"],
      }),
      node("pin-test", {
        kind: "dispatch",
        role: "worker",
        writes: true,
        timebox_min: 30,
        max_attempts: 3,
        playbook_steps: ["refactoring#1"],
      }),
      node("name-shape", {
        kind: "dispatch",
        role: "explorer",
        writes: false,
        timebox_min: 20,
        max_attempts: 2,
        playbook_steps: ["refactoring#2"],
      }),
      node("architect-plan", {
        kind: "dispatch",
        role: "architect",
        writes: false,
        timebox_min: 40,
        max_attempts: 2,
        playbook_steps: ["refactoring#3"],
        when: { kind: "crosses_function_boundary" },
      }),
      node("implement", {
        kind: "dispatch",
        role: "worker",
        writes: true,
        timebox_min: 60,
        max_attempts: 3,
        playbook_steps: ["refactoring#4", "refactoring#5"],
      }),
      node("equivalence", {
        kind: "dispatch",
        role: "worker",
        writes: true,
        timebox_min: 30,
        max_attempts: 3,
        playbook_steps: ["refactoring#6"],
      }),
      node("g-advance-worth", {
        kind: "gate",
        writes: false,
        timebox_min: 5,
        max_attempts: 3,
        playbook_steps: ["refactoring#7"],
      }),
      ...retryImpl.nodes,
      ...retryPin.nodes,
    ],
    edges: [
      edge("pin-explore", "pin-test"),
      edge("pin-explore", "stopped", "fail"),
      edge("pin-test", "name-shape"),
      edge("pin-test", "g-retry-pin", "fail"),
      ...retryPin.edges,
      edge("name-shape", "architect-plan"),
      edge("name-shape", "stopped", "fail"),
      edge("architect-plan", "implement"),
      edge("architect-plan", "stopped", "fail"),
      edge("implement", "equivalence"),
      edge("implement", "g-retry-implement", "fail"),
      edge("implement", "astra-unstick", "fingerprint_repeat"),
      ...retryImpl.edges,
      edge("equivalence", "g-advance-worth"),
      edge("equivalence", "implement", "fail"),
      edge("g-advance-worth", "open-pr", "gate:advance"),
      edge("g-advance-worth", "stopped", "gate:stay"),
    ],
  };
  return assemble("refactoring", ["refactoring", ...PR_TAIL_COVERS], "pin-explore", unit, prTail({ reviseTo: "implement", unstickTo: "implement" }), REFACTORING_ADAPTATIONS);
}

function investigationGraph(): GraphSpec {
  return spec(
    "investigation",
    ["investigation"],
    "explore",
    [
      node("explore", {
        kind: "dispatch",
        role: "explorer",
        writes: false,
        timebox_min: 20,
        max_attempts: 3,
        playbook_steps: ["investigation#1"],
      }),
      node("research", {
        kind: "plugin_task",
        role: "researcher",
        writes: false,
        timebox_min: 25,
        max_attempts: 3,
        playbook_steps: ["investigation#1"],
      }),
      node("report", {
        kind: "tool",
        writes: false,
        timebox_min: 15,
        max_attempts: 2,
        playbook_steps: ["investigation#3", "investigation#4"],
      }),
      ...INVESTIGATION_TERMINALS,
    ],
    [
      edge("explore", "research"),
      edge("explore", "stopped", "fail"),
      edge("research", "report"),
      edge("research", "stopped", "fail"),
      edge("report", "done"),
      edge("report", "stopped", "fail"),
    ],
    INVESTIGATION_ADAPTATIONS,
  );
}

function prGraph(): GraphSpec {
  const tail = prTail({ reviseTo: "fix-ci", unstickTo: "fix-ci" });
  return spec("pr", [...PR_TAIL_COVERS], "open-pr", tail.nodes, tail.edges, [...PR_TAIL_ADAPTATIONS]);
}

export const PSTACK_GRAPHS: Record<GraphTaskType, GraphSpec> = {
  "bug-fix": bugFixGraph(),
  feature: featureGraph(),
  refactoring: refactoringGraph(),
  investigation: investigationGraph(),
  pr: prGraph(),
};

export function graphForTask(taskType: GraphTaskType): GraphSpec {
  return PSTACK_GRAPHS[taskType];
}

export function allGraphs(): GraphSpec[] {
  return TASK_TYPES.map((id) => PSTACK_GRAPHS[id]);
}
