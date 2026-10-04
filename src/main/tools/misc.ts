import { KeelError } from "../host.ts";
import { node, requireString, type ToolContext } from "../context.ts";

export async function worktreeTool(ctx: ToolContext, args: Record<string, unknown>) {
  const op = requireString(args, "op");
  const repoDir = requireString(args, "repo_dir");
  if (op === "create") return node(ctx, "worktree/create", { repo_dir: repoDir, name: requireString(args, "name"), ...(typeof args.base_ref === "string" ? { base_ref: args.base_ref } : {}) });
  if (op === "audit") return { rows: await node(ctx, "worktree/audit", { repo_dir: repoDir }) };
  if (op !== "prune") throw new KeelError("INVALID_INPUT", "op 只能是 create、audit、prune。");
  const rows = await node<{ path: string; bucket: string; branch: string | null }[]>(ctx, "worktree/audit", { repo_dir: repoDir });
  const wanted = Array.isArray(args.paths) ? (args.paths as string[]) : rows.filter((r) => r.bucket === "safe").map((r) => r.path);
  const safe = rows.filter((r) => r.bucket === "safe" && wanted.includes(r.path));
  const refused = wanted.filter((p) => !safe.some((s) => s.path === p));
  if (!safe.length) return { removed: [], refused, note: "没有审计为 safe（干净且已合并）的 worktree，未删除任何东西。" };
  const c = await ctx.host.confirm({ body: `删除 ${safe.length} 个已合并且干净的 worktree 及其本地分支：\n${safe.map((s) => s.path).join("\n")}`.slice(0, 300), confirmText: "删除", cancelText: "保留", danger: true });
  if (!c.ok) throw new KeelError("CONFIRM_UNAVAILABLE", `没能弹出确认框（${c.errorCode ?? "未知"}），未删除。`);
  if (!c.confirmed) throw new KeelError("USER_DECLINED", "用户选择保留，未删除任何 worktree。");
  const r = await node<{ removed: string[]; refused: { path: string; reason: string }[] }>(ctx, "worktree/prune", { repo_dir: repoDir, paths: safe.map((s) => s.path) });
  return { removed: r.removed, refused: [...refused.map((p) => ({ path: p, reason: "审计不是 safe" })), ...r.refused] };
}

export async function rolesTool(ctx: ToolContext, args: Record<string, unknown>) {
  const op = typeof args.op === "string" ? args.op : "show";
  if (!["show", "refresh"].includes(op)) throw new KeelError("INVALID_INPUT", "op 只能是 show 或 refresh。");
  // Both ops re-read routing.json; "refresh" exists so callers can say they want a fresh read.
  return node(ctx, "routes/read", { lead_model: typeof args.lead_model === "string" ? args.lead_model : null });
}
