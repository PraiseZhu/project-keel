// JSON-RPC method table for the Node worker. There is deliberately no merge method:
// tests/merge-guard.test.ts asserts the table never grows one.

import { EMPTY_PROFILE, type KeelProfile } from "../shared/types.ts";
import { ToolError, gh, resolveTool } from "./env.ts";
import { audit, createWorktree, gitState, prune } from "./git/worktree.ts";
import { prBoard, prOpen, prReady, prReply, prThreads } from "./pr/actions.ts";
import { resolveExisting, snapshot } from "./pr/snapshot.ts";
import { inspectVigil } from "./pr/vigil-handoff.ts";
import { roles } from "./routes/routing.ts";

declare const __KEEL_PROFILE__: KeelProfile | undefined;
const BUILT_PROFILE: KeelProfile = typeof __KEEL_PROFILE__ !== "undefined" ? __KEEL_PROFILE__ : EMPTY_PROFILE;

export type Params = Record<string, any> & { profile?: KeelProfile };
export type Method = (p: Params, profile: KeelProfile) => Promise<unknown>;

const methods: Record<string, Method> = {
  "env/diagnose": async () => {
    const out: Record<string, unknown> = {};
    for (const t of ["gh", "git"] as const) {
      try {
        out[t] = await resolveTool(t);
      } catch (e) {
        out[t] = { error: (e as Error).message };
      }
    }
    try {
      out.gh_user = (await gh(["api", "user", "--jq", ".login"], { timeoutMs: 30_000 })).trim();
    } catch (e) {
      out.gh_user = { error: (e as Error).message };
    }
    out.node = process.version;
    return out;
  },
  "pr/snapshot": (p, profile) => snapshot(profile, p as any),
  "pr/open": (p, profile) => prOpen(profile, p as any),
  "pr/resolve": (p) => resolveExisting(p as any),
  "pr/ready": (p, profile) => prReady(profile, p as any),
  "pr/handoff-state": (p, profile) => inspectVigil(profile, p.repo, p.pr),
  "pr/threads": (p, profile) => prThreads(profile, p as any),
  "pr/reply": (p) => prReply(p as any),
  "pr/board": (p, profile) => prBoard(profile, p as any),
  "git/state": (p) => gitState(p.repo_dir),
  "worktree/create": (p) => createWorktree(p as any),
  "worktree/audit": (p) => audit(p.repo_dir),
  "worktree/prune": (p) => prune(p.repo_dir, p.paths ?? []),
  "routes/read": async (p, profile) => roles(profile.routingPath, p.lead_agent ?? null),
};

export function register(name: string, fn: Method): void {
  if (/merge/i.test(name)) throw new Error(`refusing to register ${name}: Keel never merges`);
  methods[name] = fn;
}

export function methodNames(): string[] {
  return Object.keys(methods).sort();
}

export async function dispatch(method: string, params: Params = {}): Promise<{ result?: unknown; error?: { code: number; message: string; data?: unknown } }> {
  const fn = methods[method];
  if (!fn) return { error: { code: -32601, message: "Method not found" } };
  const profile = params.profile ?? BUILT_PROFILE;
  try {
    return { result: await fn(params, profile) };
  } catch (e) {
    const code = e instanceof ToolError ? e.code : "INTERNAL";
    // The host forwards only `message` to main.js, so the business code rides in front of it.
    return { error: { code: -32000, message: `${code}: ${e instanceof Error ? e.message : String(e)}`, data: { errorCode: code } } };
  }
}
