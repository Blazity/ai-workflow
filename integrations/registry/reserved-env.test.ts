/**
 * `RESERVED_ENVIRONMENT_VARIABLES` in the integration SDK is what stops an
 * integration declaring a connection field on a variable core reads for
 * itself: a field on `DATABASE_URL` would read Connected from core's own
 * database credentials and hand the value back through the dashboard, and no
 * credential word in the name would catch it.
 *
 * That list is in a package that cannot see the worker, so nothing but this
 * test holds it equal to what the worker actually reads. It lives in the
 * registry, the one package whose job is already to span core and the
 * integrations, and it reads the worker file as text rather than importing it,
 * so no package gains an import it may not have. `pnpm run test:packages` runs
 * it, and CI runs that on every pull request.
 *
 * Both directions are held: every variable core declares is reserved, and
 * every reserved name is one core declares or one of the few it reads without
 * declaring. A reserved name nothing reads would refuse an integration a name
 * for no reason, and would outlive the variable it was reserved for.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { RESERVED_ENVIRONMENT_VARIABLES } from "@integrations/sdk";

const RUNTIME_ENV = resolve(import.meta.dirname, "../../apps/worker/src/infra/runtime-env.ts");
const NAME = "apps/worker/src/infra/runtime-env.ts";

/**
 * Names the platform or the operating system sets and core reads without
 * declaring. Nothing in this repository writes them, so each carries why core
 * cares rather than a file.
 */
const SET_BY_THE_PLATFORM: Readonly<Record<string, string>> = {
  HOME: "the process environment the sandbox and the agent CLIs inherit",
  PATH: "the process environment the sandbox and the agent CLIs inherit",
  VERCEL: "set by Vercel; read by the workflow world plugin to tell a deployment from a local run",
  VERCEL_ENV: "set by Vercel; which deployment environment this is",
  VERCEL_GIT_COMMIT_SHA: "set by Vercel; the commit /health reports",
  SERVERLESS: "set by the serverless runtime; read by the workflow world plugin",
};

/**
 * Names core reads that runtime-env.ts does not declare, each with the file
 * that reads it. The test opens each file and looks for the name, so a row
 * outlives its reader by one failing run, not silently.
 */
const READ_WITHOUT_DECLARING: Readonly<Record<string, string>> = {
  LOG_LEVEL: "apps/worker/src/infra/logger.ts",
  POST_PR_GATE_CONFIG_PATH: "apps/worker/src/post-pr-gate/config.ts",
  WORKFLOW_SCHEDULING_GOLDEN_SINK: "apps/worker/src/workflow-graph-suites/scenarios/harness.ts",
};

/** The keys of the `server` block, which is every variable the worker declares. */
async function declaredVariables(): Promise<string[]> {
  const source = await readFile(RUNTIME_ENV, "utf8");
  const names = [...source.matchAll(/^ {4}([A-Z][A-Z0-9_]*):/gmu)].map((match) => match[1]!);
  assert.ok(names.length > 20, `${NAME} no longer reads as a list of variables`);
  return names;
}

test("every variable core declares for itself is reserved against integrations", async () => {
  const missing = (await declaredVariables()).filter(
    (variable) => !RESERVED_ENVIRONMENT_VARIABLES.includes(variable),
  );
  assert.deepEqual(
    missing,
    [],
    `${NAME} declares these and the SDK does not reserve them, so an integration could claim one: ` +
      `${missing.join(", ")}. Add them to RESERVED_ENVIRONMENT_VARIABLES, or, if the variable belongs to a provider, ` +
      "move it into that integration's manifest.",
  );
});

test("every reserved variable is one core reads", async () => {
  const declared = new Set(await declaredVariables());
  const unread = RESERVED_ENVIRONMENT_VARIABLES.filter(
    (variable) =>
      !declared.has(variable) &&
      !Object.hasOwn(READ_WITHOUT_DECLARING, variable) &&
      !Object.hasOwn(SET_BY_THE_PLATFORM, variable),
  );
  assert.deepEqual(
    unread,
    [],
    `RESERVED_ENVIRONMENT_VARIABLES holds ${unread.join(", ")}, which ${NAME} does not declare and nothing here says core reads. ` +
      "Delete the name from the list, or add it to READ_WITHOUT_DECLARING with the file that reads it.",
  );
});

test("each variable read without declaring is still read by the file its row names", async () => {
  const stale: string[] = [];
  for (const [variable, path] of Object.entries(READ_WITHOUT_DECLARING)) {
    const source = await readFile(resolve(import.meta.dirname, "../..", path), "utf8").catch(() => "");
    if (!new RegExp(`\\b${variable}\\b`, "u").test(source)) stale.push(`${variable} (${path})`);
  }
  assert.deepEqual(
    stale,
    [],
    `These rows name a reader that no longer reads the variable, or no longer exists: ${stale.join(", ")}. ` +
      "Point the row at the file that reads it now, or delete the name from RESERVED_ENVIRONMENT_VARIABLES and this list.",
  );
});
