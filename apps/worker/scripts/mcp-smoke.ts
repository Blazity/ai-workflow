// C3: thin CLI wrapper around src/mcp/smoke-client.ts.
//
// All the checking logic lives in smoke-client.ts, which is testable under
// vitest. This file only reads argv/env and prints the result: a test file
// under scripts/ would never run, since apps/worker/vitest.config.ts's
// `include` is limited to src/**/*.test.ts and *.test.ts.
import { runMcpSmoke, smokeExitCode } from "../src/mcp/smoke-client.js";

const baseUrl = process.argv[2] ?? process.env.MCP_SMOKE_BASE_URL;
const token = process.argv[3] ?? process.env.MCP_SMOKE_TOKEN;

if (!baseUrl) {
  console.error(
    "Usage: pnpm mcp:smoke <base-url> [token]  (or MCP_SMOKE_BASE_URL / MCP_SMOKE_TOKEN env vars)",
  );
  process.exit(1);
}

const evidence = await runMcpSmoke({ baseUrl, token });
console.log(JSON.stringify(evidence, null, 2));
process.exit(smokeExitCode(evidence));
