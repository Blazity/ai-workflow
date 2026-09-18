import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// A pull request touching any of these has to prove itself on the engine canary
// before it can merge. The canary is the only job in this repository that loads
// the deployed bundle and drives a real run through it, and it costs 95 minutes
// behind a shared fixture queue, so this list is the whole definition of "could
// this change break what only the canary can see". Every entry says what it
// protects: nothing joins the list by accident, and nothing leaves it without
// the same kind of reason.
const CANARY_PREFIXES = [
  // The durable steps the canary run executes one at a time on the platform.
  // The suite dispatches a fixture run and refuses anything but a success
  // (apps/worker/e2e/harness-profiles/preview-canary.ts, waitForSuccessfulRun).
  "apps/worker/src/engine/",
  // Every run row, harness manifest, log envelope and replay attempt the canary
  // reads back out of the deployed database
  // (apps/worker/e2e/replay/canary-contract.ts, assertReplayCanaryEvidence).
  "apps/worker/src/db/",
  // The shared contracts and schemas both ends of the canary speak, and the
  // workspace packages whose version skew only the deployed bundle resolves.
  "packages/",
  // Three directories out of apps/worker/src/services/, and only three. The
  // rest of that tree stays out on purpose: it is large, it changes constantly,
  // and none of it sits on the path the canary walks. These three do, so they
  // are listed by directory rather than by the file that happens to hold the
  // logic today. A file path here would answer "not in scope" the day somebody
  // renames the file, which is the same silent failure this list exists to
  // prevent.
  //
  // Cancel, claim release and the end-of-run write. The canary cancels a
  // stranded predecessor on the shared fixture tickets before it starts
  // (apps/worker/e2e/harness-profiles/preview-canary.ts, runs.cancel).
  "apps/worker/src/services/run-lifecycle/",
  // The /health payload the identity preflight reads before a single canary
  // write: the deployment commit, the database environment and its fingerprint
  // all come from here (scripts/ci/engine-canary-preflight.ts).
  "apps/worker/src/services/system/",
  // The run detail every canary assertion is made against. runs.get,
  // runs.result and runs.logs all sanitize and attribute through this directory
  // before the canary ever sees a status or a model (apps/worker/src/mcp/tools/runs.ts).
  "apps/worker/src/services/overview/",
  // The surface the canary drives: every assertion it makes arrives through an
  // MCP tool call against the deployed target, from system.capabilities to
  // runs.logs (apps/worker/e2e/harness-profiles/preview-canary.ts, callTool).
  "apps/worker/src/mcp/",
  // The deployed HTTP surface the canary talks to: /mcp, the OAuth discovery
  // document its machine credential reads
  // (apps/worker/e2e/harness-profiles/mcp-machine-credential.ts) and /health,
  // which the job waits on and the preflight reads the deployment and database
  // identity from. This is also where the zod skew below actually lands: a one
  // argument z.record in a route handler answered 500 in production under the
  // zod the bundle resolves, while every test passed under the one the catalog
  // pins.
  "apps/worker/src/routes/",
  // The agent phase the fixture run actually executes. The canary reads the
  // provider and the model back out of that run's harness manifest
  // (apps/worker/e2e/harness-profiles/preview-canary.ts, CANARY_FIXTURE_MODELS).
  "apps/worker/src/sandbox/",
  // Profile resolution and the manifest hash the fixture file pins. A change
  // here silently invalidates the profileVersion and skillArtifactHash the
  // canary asserts against
  // (apps/worker/e2e/harness-profiles/engine-canary-fixtures.ts).
  "apps/worker/src/harness-profiles/",
  // The canary suites themselves and the fixture identity they pin.
  "apps/worker/e2e/harness-profiles/",
  "apps/worker/e2e/replay/",
  // The gate's own scripts: this selection, and the preflight that proves the
  // deployment commit and the database identity before any canary write.
  "scripts/ci/engine-canary",
  // The job that runs all of it: its steps, its target validation, its queue.
  ".github/workflows/ci.yml",
  // The three dependency inputs, and they are here on purpose rather than by
  // accident. Twice this project shipped a production outage that exists only
  // in the deployed bundle and that no test in this repository can see: Nitro
  // traces one node_modules/zod for the whole worker function and takes it from
  // @workflow/core, which is zod 4, while the catalog in pnpm-workspace.yaml
  // pins 3.25; and a zod/v3 subpath import answered ERR_MODULE_NOT_FOUND on
  // Vercel alone. Both arrived through a dependency, not through worker source,
  // so a list made of source directories cannot see that class coming and the
  // lockfile is the signal that can. The cost is real: a lockfile-heavy week
  // queues on a 95 minute job. It is paid deliberately, for the one failure
  // class no other job here can catch. Do not delete these three as noise.
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "apps/worker/package.json",
] as const;
const MIGRATIONS_PREFIX = "apps/worker/drizzle/";

export interface EngineCanaryScope {
  run: boolean;
  migrations: boolean;
  matched: string[];
}

export function engineCanaryScope(changedPaths: string[]): EngineCanaryScope {
  const matched = changedPaths.filter((path) =>
    CANARY_PREFIXES.some((prefix) => path.startsWith(prefix)),
  );
  const migrations = changedPaths.some((path) =>
    path.startsWith(MIGRATIONS_PREFIX),
  );
  return { run: matched.length > 0, migrations, matched };
}

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    if (!token?.startsWith("--") || value === undefined || value.startsWith("--")) {
      continue;
    }
    result[token.slice(2)] = value;
    index += 1;
  }
  return result;
}

function changedPaths(base: string, head: string): string[] {
  const output = execFileSync(
    "/usr/bin/git",
    ["diff", "--name-only", "-z", "--no-renames", `${base}...${head}`, "--"],
    { encoding: "buffer" },
  );
  return output
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0);
}

function appendLine(path: string | undefined, line: string): void {
  if (path) appendFileSync(path, `${line}\n`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.base || !args.head) {
    console.error("FAIL usage: engine-canary-scope --base <ref> --head <ref>");
    process.exitCode = 2;
    return;
  }

  try {
    const result = engineCanaryScope(changedPaths(args.base, args.head));
    for (const path of result.matched) console.log(path);
    appendLine(process.env.GITHUB_OUTPUT, `run=${String(result.run)}`);
    appendLine(
      process.env.GITHUB_OUTPUT,
      `migrations=${String(result.migrations)}`,
    );
    if (!process.env.GITHUB_OUTPUT) {
      console.log(`run=${String(result.run)}`);
      console.log(`migrations=${String(result.migrations)}`);
    }
    if (!result.run) {
      appendLine(
        process.env.GITHUB_STEP_SUMMARY,
        "engine-canary: skipped, no engine, db or packages change",
      );
    }
  } catch (error) {
    console.error(`FAIL engine-canary scope: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
