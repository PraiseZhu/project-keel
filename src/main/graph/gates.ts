// Five graph gates (附 D). Deterministic checks and Jev option builders only.
// This file must not import judge.ts, jev/templates.ts, jev/policy.ts, or tools/pstack.ts.

export const UNIT_GRAPHS = ["bug-fix", "feature", "refactoring", "investigation"] as const;
export type UnitGraph = (typeof UNIT_GRAPHS)[number];
export type GateId = "G-route" | "G-advance" | "G-retry" | "G-accept" | "G-arena";
export type GateKind = "direction" | "mechanical";
export type ErrorMode = "overlong" | "overbudget" | "network" | "tool" | "unknown";

export type Evidence = Record<string, unknown>;

export interface GateDef {
  readonly id: GateId;
  readonly kind: GateKind;
  /** When set, low-confidence always goes to the lead (G-accept: Astra must not re-judge Astra). */
  readonly forceLeadOnLow?: boolean;
  deterministic(evidence: Evidence): string | undefined;
  options(evidence: Evidence): readonly string[];
  fallback(evidence: Evidence): string;
  question(evidence: Evidence): { state: unknown; instructions: string; criteria: Record<string, string | null> };
}

const KEYWORDS: readonly { re: RegExp; graph: UnitGraph }[] = [
  { re: /重构|refactor/, graph: "refactoring" },
  { re: /bug|修复|报错|崩溃|fix|异常|失败/, graph: "bug-fix" },
  { re: /怎么|如何|why|how|为什么|调查|investigat|原理/, graph: "investigation" },
  { re: /新增|功能|feature|实现|支持/, graph: "feature" },
];

export function keywordCandidates(task: string): UnitGraph[] {
  const t = task.toLowerCase();
  const hits: UnitGraph[] = [];
  for (const k of KEYWORDS) if (k.re.test(t) && !hits.includes(k.graph)) hits.push(k.graph);
  return hits;
}

function taskText(e: Evidence): string {
  return String(e.task ?? e.goal ?? "");
}

function routeOptions(e: Evidence): string[] {
  const hits = keywordCandidates(taskText(e));
  const opts = hits.length ? hits : [...UNIT_GRAPHS];
  return opts.slice(0, 3);
}

function num(e: Evidence, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = e[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

function str(e: Evidence, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = e[k];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

function bool(e: Evidence, ...keys: string[]): boolean | undefined {
  for (const k of keys) {
    const v = e[k];
    if (typeof v === "boolean") return v;
  }
  return undefined;
}

function failCount(e: Evidence): number {
  return num(e, "consecutive_failures", "fail_count") ?? 1;
}

function errorMode(e: Evidence): ErrorMode {
  const m = str(e, "error_mode");
  if (m === "overlong" || m === "overbudget" || m === "network" || m === "unknown") return m;
  if (m === "tool" || m === "tool_error") return "tool";
  return "unknown";
}

function retryDefault(e: Evidence): string {
  if (failCount(e) >= 2) return "stop";
  const mode = errorMode(e);
  if (mode === "overlong" || mode === "overbudget" || mode === "tool") return "escalate";
  return "retry";
}

export const GATES: Record<GateId, GateDef> = {
  "G-route": {
    id: "G-route",
    kind: "direction",
    deterministic(e) {
      const named = str(e, "playbook", "named");
      if (named && (UNIT_GRAPHS as readonly string[]).includes(named)) return named;
      const hits = keywordCandidates(taskText(e));
      return hits.length === 1 ? hits[0] : undefined;
    },
    options: routeOptions,
    fallback: (e) => routeOptions(e)[0] ?? "investigation",
    question(e) {
      const options = routeOptions(e);
      return {
        state: { task: taskText(e), candidates: options },
        instructions: "这个任务应该走哪张单元图？只从给出的候选里选。",
        criteria: Object.fromEntries(options.map((o) => [o, null])),
      };
    },
  },
  "G-advance": {
    id: "G-advance",
    kind: "mechanical",
    deterministic(e) {
      const present = bool(e, "evidence_present", "present") === true;
      const head = bool(e, "head_matches") === true;
      const code = num(e, "exit_code");
      return present && head && code === 0 ? "advance" : undefined;
    },
    options: () => ["advance", "stay"],
    fallback(e) {
      return bool(e, "prior_stay") === true || bool(e, "new_evidence") === true ? "advance" : "stay";
    },
    question(e) {
      return {
        state: e,
        instructions: "证据是否足够进入下一节点？head 一致且退出码为 0 选 advance，否则 stay。",
        criteria: { advance: "进入下一节点", stay: "留在当前节点，等新证据" },
      };
    },
  },
  "G-retry": {
    id: "G-retry",
    kind: "mechanical",
    deterministic(e) {
      if (failCount(e) >= 2) return "stop";
      const mode = errorMode(e);
      if (mode === "unknown" && !str(e, "error_mode")) return undefined;
      if (mode === "unknown") return undefined;
      return retryDefault(e);
    },
    options: () => ["retry", "escalate", "stop"],
    fallback: retryDefault,
    question(e) {
      return {
        state: { error_mode: errorMode(e), consecutive_failures: failCount(e) },
        instructions: "节点失败后下一步：原样重试、升级换模型或缩小范围、还是放弃并开人工门？",
        criteria: { retry: "原样重试", escalate: "换模型或缩小范围", stop: "放弃该节点，开人工门" },
      };
    },
  },
  "G-accept": {
    id: "G-accept",
    kind: "direction",
    forceLeadOnLow: true,
    deterministic(e) {
      const v = str(e, "verdict", "astra_verdict");
      return v === "PASS" || v === "PASS+NOTES" ? "adopt" : undefined;
    },
    options: () => ["adopt", "revise", "ask_user"],
    fallback: () => "ask_user",
    question(e) {
      return {
        state: { verdict: str(e, "verdict", "astra_verdict") ?? "", notes: e.notes ?? null },
        instructions: "是否采纳这次复核意见？",
        criteria: { adopt: "按意见改", revise: "保留方向但改具体改动", ask_user: "交给主控/用户" },
      };
    },
  },
  "G-arena": {
    id: "G-arena",
    kind: "direction",
    deterministic(e) {
      const lines = num(e, "lines", "changed_lines");
      return lines !== undefined && lines <= 30 ? "single" : undefined;
    },
    options: () => ["single", "arena"],
    fallback: () => "single",
    question(e) {
      return {
        state: { lines: num(e, "lines", "changed_lines") ?? null },
        instructions: "要不要并行多个实现方案？改动不大时选 single。",
        criteria: { single: "一条实现路径", arena: "并行两个候选再收口" },
      };
    },
  },
};

export function gateOf(id: string): GateDef {
  const g = GATES[id as GateId];
  if (!g) throw new Error(`unknown gate ${id}`);
  return g;
}
