// Operator CLI for the MCP dogfood harness. Thin on purpose, exactly like
// mcp-smoke.ts: everything worth testing lives under src/mcp-dogfood/, because
// a test file under scripts/ would never run (vitest.config.ts only includes
// src/**/*.test.ts and *.test.ts).
//
// Separate from `pnpm mcp:smoke` rather than folded into it. The smoke check
// answers one question, "is this deployment up and enforcing auth", in a couple
// of seconds, and deploy steps gate on its exit code. This walks the whole tool
// surface with two probes per tool and is the slower, broader check an operator
// runs deliberately. Merging them would make a routine deploy gate fail on a
// coverage gap, and make the fast check slow.
import { loadContract } from "../src/mcp-dogfood/plan.js";
import { renderReport } from "../src/mcp-dogfood/report.js";
import { dogfoodExitCode, runDogfood } from "../src/mcp-dogfood/run.js";

const VALUED_FLAGS = new Set(["ticket", "run", "definition", "trigger"]);
const values = new Map<string, string>();
const switches = new Set<string>();
const bare: string[] = [];

const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index]!;
  if (!argument.startsWith("--")) {
    bare.push(argument);
    continue;
  }
  const name = argument.slice(2);
  if (VALUED_FLAGS.has(name)) {
    values.set(name, argv[index + 1] ?? "");
    index += 1;
  } else {
    switches.add(name);
  }
}

const flag = (name: string): string | undefined => values.get(name) || undefined;

const baseUrl = bare[0] ?? process.env.MCP_DOGFOOD_BASE_URL;
// Read from the environment by preference: an argv token is visible in `ps`.
const token = process.env.MCP_DOGFOOD_TOKEN ?? bare[1];

if (!baseUrl) {
  console.error(
    [
      "Usage: pnpm mcp:dogfood <base-url> [token] [options]",
      "",
      "  Walks every tool in the frozen MCP contract against a deployment and",
      "  reports, per tool, whether it works, refuses correctly, or FAILS.",
      "",
      "  Without a token every call is refused by auth and that is reported as a",
      "  PASS: it proves the deployment enforces auth. Nothing behind the gate is",
      "  checked, which the report says in as many words.",
      "",
      "Options:",
      "  --ticket <key>       real ticket key, so tickets.* hit real data",
      "  --run <id>           real run id, so runs.* hit real data",
      "  --definition <id>    real workflow definition id",
      "  --trigger <nodeId>   trigger node id for the workflows.* probes",
      "  --allow-dispatch     really call workflows.dispatch only (off by default)",
      "  --json               emit the raw report instead of the readable one",
      "",
      "Environment: MCP_DOGFOOD_BASE_URL, MCP_DOGFOOD_TOKEN (preferred over argv).",
    ].join("\n"),
  );
  process.exit(1);
}

const definition = flag("definition");
const report = await runDogfood({
  baseUrl,
  token,
  contract: loadContract(),
  fixtures: {
    ...(flag("ticket") ? { ticketKey: flag("ticket")! } : {}),
    ...(flag("run") ? { runId: flag("run")! } : {}),
    ...(definition ? { definitionId: Number(definition) } : {}),
    ...(flag("trigger") ? { triggerNodeId: flag("trigger")! } : {}),
  },
  allowDispatch: switches.has("allow-dispatch"),
});

console.log(switches.has("json") ? JSON.stringify(report, null, 2) : renderReport(report));
process.exit(dogfoodExitCode(report));
