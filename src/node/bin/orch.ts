// Standalone `orch` CLI shipped as plugin/node/orch.mjs, the same command surface agents
// run upstream (`bun scripts/orch.ts …`), here `node <keel>/node/orch.mjs …`.
import { main } from "../orch/cli.ts";

main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
