import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CANARY_PREFIXES = [
  "apps/worker/src/engine/",
  "apps/worker/src/db/",
  "packages/",
  // The gate itself and the run lifecycle it drives: a change to either must
  // prove itself on the canary before it can merge.
  "apps/worker/src/services/run-lifecycle/",
  "apps/worker/e2e/harness-profiles/",
  "apps/worker/e2e/replay/",
  "scripts/ci/engine-canary",
  ".github/workflows/ci.yml",
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
