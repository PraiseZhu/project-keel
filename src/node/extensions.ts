// P2/P3 RPC methods register here so rpc.ts stays the single method table.
import { register } from "./rpc.ts";
import { cleanup, collect, prepare } from "./fanout/fanout.ts";

register("fanout/prepare", (p, profile) => prepare(profile, p as any));
register("fanout/collect", (p) => collect(p as any));
register("fanout/cleanup", (p) => cleanup(p as any));
import { checkPlan } from "./plan/check-plan.ts";
import { runOrch } from "./orch/rpc.ts";
import { readFileSync } from "node:fs";

register("plan/check", async (p) => checkPlan(typeof p.text === "string" ? p.text : readFileSync(String(p.path), "utf8"), String(p.path ?? "plan.md")));
register("orch/run", (p) => runOrch(p as any));
