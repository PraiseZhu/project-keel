// Per-request working directory for the upstream watch-pr runner. RPC requests can
// interleave, so the cwd travels in AsyncLocalStorage instead of a module global.

import { AsyncLocalStorage } from "node:async_hooks";
import { resolveTool, runRaw } from "./env.ts";
import { setCommandRunner } from "./pr/upstream/github.ts";

const cwdStore = new AsyncLocalStorage<string | undefined>();

export function withCwd<T>(cwd: string | undefined, fn: () => Promise<T>): Promise<T> {
  return cwdStore.run(cwd, fn);
}

export function installUpstreamRunner(): void {
  setCommandRunner(async (argv) => {
    const [tool, ...args] = argv;
    const bin = tool === "gh" || tool === "git" ? await resolveTool(tool) : tool;
    const res = await runRaw(bin, args, { cwd: cwdStore.getStore(), timeoutMs: 90_000 });
    return { code: res.code, stdout: res.stdout, stderr: res.stderr };
  });
}
