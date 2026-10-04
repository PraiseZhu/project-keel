// Shapes exchanged between main.js (browser sandbox) and the Node worker.
// Keep this file free of runtime imports so both bundles can share it.
// Personal values (repo names, absolute paths) never live here: they come from
// config/profile.local.json, injected at build time as `KEEL_PROFILE`.

/** Lane presets. Repos are mapped to a preset by the profile. */
export type LanePreset = "draft-gated-handoff" | "gated-handoff" | "personal";

export interface LaneRule {
  readonly preset: LanePreset;
  /** Open new PRs as Draft. The user's default elsewhere is non-draft. */
  readonly draftFirst: boolean;
  /** Gate checked before `gh pr ready`. */
  readonly readyGate: "required-checks" | "none";
  /** After Ready, who owns the PR. `automation` means the author session must stop touching it. */
  readonly postReadyOwner: "automation" | "self";
  /** Local multi-model review default. */
  readonly localInterrogate: "off" | "on-demand";
  /** Repo-relative rule files read from the base branch, never from the PR worktree. */
  readonly baseRuleFiles?: {
    readonly requiredChecks?: string;
    readonly prRules?: string;
    readonly prTemplate?: string;
  };
}

export const LANE_PRESETS: Readonly<Record<LanePreset, LaneRule>> = {
  "draft-gated-handoff": {
    preset: "draft-gated-handoff",
    draftFirst: true,
    readyGate: "required-checks",
    postReadyOwner: "automation",
    localInterrogate: "off",
  },
  "gated-handoff": {
    preset: "gated-handoff",
    draftFirst: false,
    readyGate: "required-checks",
    postReadyOwner: "automation",
    localInterrogate: "on-demand",
  },
  personal: {
    preset: "personal",
    draftFirst: false,
    readyGate: "none",
    postReadyOwner: "self",
    localInterrogate: "on-demand",
  },
};

export interface LaneMatch {
  /** `owner/repo`, case-insensitive. */
  readonly repo: string;
  readonly preset: LanePreset;
  /** Absolute path of a preflight script the agent should run before pushing. */
  readonly preflight?: string;
  /** Optional per-repo rule-file overrides. */
  readonly baseRuleFiles?: LaneRule["baseRuleFiles"];
}

export interface KeelProfile {
  readonly lanes: readonly LaneMatch[];
  /** Absolute path of the Orca routing.json. Null = fanout/roles fail closed. */
  readonly routingPath: string | null;
  /** Repos scanned by pr_board when no `repos` argument is given (`owner/repo`). */
  readonly boardRepos: readonly string[];
  /** Where plans go (playbooks reference it). */
  readonly plansDir: string | null;
  /** Free-form private overlay rules appended to the keel manual at build time. */
  readonly overlayNote?: string;
}

export const EMPTY_PROFILE: KeelProfile = {
  lanes: [],
  routingPath: null,
  boardRepos: [],
  plansDir: null,
};

export interface JevThresholds {
  readonly act: number;
  /** J7 (test-legacy) uses the stricter line from the approved approve-exec policy. */
  readonly strict: number;
}

export const DEFAULT_THRESHOLDS: JevThresholds = { act: 0.75, strict: 0.8 };

export type PrAction =
  | "report_merged_or_closed"
  | "report_conflict_rebase_needed"
  | "triage_review_threads"
  | "classify_ci_failure"
  | "wait_for_ci"
  | "wait_for_review"
  | "mark_ready"
  | "handoff"
  | "report_mergeable"
  | "stopped_after_handoff";

export interface RequiredGate {
  readonly applies: boolean;
  readonly required: readonly string[];
  readonly passed: readonly string[];
  readonly failing: readonly string[];
  readonly pending: readonly string[];
  readonly missing: readonly string[];
  readonly ok: boolean;
  readonly sources: readonly string[];
}

export interface PrSummary {
  readonly repo: string;
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly state: "OPEN" | "CLOSED" | "MERGED";
  readonly isDraft: boolean;
  readonly headSha: string | null;
  readonly headRef: string;
  readonly baseRef: string;
  readonly mergeable: string;
  readonly mergeStateStatus: string;
  readonly reviewDecision: string | null;
  readonly labels: readonly string[];
}

export type DecisionKind = "blocker" | "waiting" | "ready" | "merged" | "closed";

export interface PrStatus {
  readonly preset: LanePreset;
  readonly rule: LaneRule;
  readonly pr: PrSummary;
  readonly decision: { readonly kind: DecisionKind; readonly blocker?: string; readonly detail?: string };
  readonly checks: { readonly failed: readonly string[]; readonly pending: readonly string[]; readonly passed: number };
  readonly unresolvedThreads: number;
  readonly gate: RequiredGate;
  readonly mergeReadyLabel: boolean;
  readonly handedOff: boolean;
  readonly allowedActions: readonly PrAction[];
  readonly nextAction: PrAction;
  readonly rendered: string;
}

export interface WorktreeAuditRow {
  readonly path: string;
  readonly branch: string | null;
  readonly ageDays: number | null;
  readonly merged: boolean;
  readonly dirty: string;
  readonly remote: string;
  readonly pr: string;
  readonly bucket: "hold-wip" | "hold-open-pr" | "safe" | "review" | "main";
}

export interface RouteSpec {
  readonly agent: string;
  readonly model: string;
  readonly effort?: string;
  readonly provider_id?: string;
}

export interface RouteWithFallbacks extends RouteSpec {
  readonly tier: string;
  readonly fallbacks: readonly RouteSpec[];
}
