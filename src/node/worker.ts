// Cindy Node worker entry: one JSON-RPC 2.0 object per line on stdin/stdout.
// stdout carries protocol messages only; diagnostics go to stderr.

import { createInterface } from "node:readline";
import { installUpstreamRunner } from "./context.ts";
import { dispatch } from "./rpc.ts";
import "./extensions.ts";

installUpstreamRunner();

function reply(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let request: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    request = JSON.parse(line);
  } catch {
    reply({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  void dispatch(String(request.method ?? ""), request.params ?? {}).then((out) => reply({ jsonrpc: "2.0", id: request.id ?? null, ...out }));
});
