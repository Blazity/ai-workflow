// C2: thin CLI wrapper around src/mcp/contract-artifact.ts.
//
// All the logic lives there, which is testable under vitest. This file only reads
// argv and prints the result: a test file under scripts/ would never run, since
// apps/worker/vitest.config.ts's `include` is limited to src/**/*.test.ts and
// *.test.ts, and tsconfig.json's `include` does not type scripts/ either.
//
//   pnpm mcp:contract:generate        rewrite the committed snapshot
//   pnpm mcp:contract:check          exit 1 when the snapshot has drifted
import {
  checkMcpContractSnapshot,
  MCP_CONTRACT_SNAPSHOT_PATH,
  writeMcpContractSnapshot,
} from "../src/mcp/contract-artifact.js";

if (process.argv.includes("--check")) {
  const result = checkMcpContractSnapshot();
  console.log(result.message);
  process.exitCode = result.ok ? 0 : 1;
} else {
  writeMcpContractSnapshot();
  console.log(`Wrote ${MCP_CONTRACT_SNAPSHOT_PATH}`);
}
