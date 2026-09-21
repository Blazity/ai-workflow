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
 * The provider variables are deliberately on the other side of the line: they
 * belong to the integrations that take them over, and the stage that moves one
 * deletes its rows here and in the worker together.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { RESERVED_ENVIRONMENT_VARIABLES } from "@integrations/sdk";

const RUNTIME_ENV = resolve(import.meta.dirname, "../../apps/worker/src/infra/runtime-env.ts");

/**
 * Each prefix names variables one integration takes over, with the stage that
 * takes them. A new provider variable in the worker belongs to one of these or
 * to the reserved list, and the test says which is missing either way.
 */
const NAME = "apps/worker/src/infra/runtime-env.ts";

// CHAT_SDK_ and SLACK_ left this table in S9, GITLAB_ in S10 and GITHUB_ in
// S11: the worker no longer declares any of them, and each provider package's
// manifest does.
const PROVIDER_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["JIRA_", "S12, Jira"],
];

/** The keys of the `server` block, which is every variable the worker declares. */
async function declaredVariables(): Promise<string[]> {
  const source = await readFile(RUNTIME_ENV, "utf8");
  const names = [...source.matchAll(/^ {4}([A-Z][A-Z0-9_]*):/gmu)].map((match) => match[1]!);
  assert.ok(names.length > 20, `${NAME} no longer reads as a list of variables`);
  return names;
}

function providerOwner(variable: string): string | undefined {
  return PROVIDER_PREFIXES.find(([prefix]) => variable.startsWith(prefix))?.[1];
}

test("every variable core declares for itself is reserved against integrations", async () => {
  const missing = (await declaredVariables()).filter(
    (variable) => !providerOwner(variable) && !RESERVED_ENVIRONMENT_VARIABLES.includes(variable),
  );
  assert.deepEqual(
    missing,
    [],
    `${NAME} declares these and the SDK does not reserve them, so an integration could claim one: ` +
      `${missing.join(", ")}. Add them to RESERVED_ENVIRONMENT_VARIABLES, or, if the variable belongs to a provider, ` +
      "give its prefix a row in PROVIDER_PREFIXES here.",
  );
});

test("no provider variable is reserved, because an integration is going to own it", async () => {
  const claimed = (await declaredVariables()).filter(
    (variable) => providerOwner(variable) && RESERVED_ENVIRONMENT_VARIABLES.includes(variable),
  );
  assert.deepEqual(
    claimed,
    [],
    `the SDK reserves ${claimed.join(", ")}, which the integration taking that provider over needs to declare. ` +
      "Reserving it would make its own integration fail conformance.",
  );
});

test("every provider prefix still names a variable the worker reads", async () => {
  const declared = await declaredVariables();
  const empty = PROVIDER_PREFIXES.filter(
    ([prefix]) => !declared.some((variable) => variable.startsWith(prefix)),
  ).map(([prefix, stage]) => `${prefix} (${stage})`);
  assert.deepEqual(
    empty,
    [],
    `these prefixes name nothing in ${NAME} any more, so the stage that owned them has landed: ` +
      `${empty.join(", ")}. Delete the row.`,
  );
});
