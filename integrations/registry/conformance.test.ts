/**
 * The contract every integration package in this repository satisfies.
 *
 * It discovers packages rather than listing them, so an integration added in a
 * later stage, a fixture and the template are all covered the day they land,
 * and it covers them whatever the fixture flag says: what may be left out of a
 * production build is still checked here. `pnpm run test:packages` runs this,
 * and `pnpm run test:packages:zod4` runs it again against the zod the worker
 * bundle resolves, which is not the one the workspace pins.
 *
 * A failure names the package, the rule and what to do; ADR-010 says why each
 * rule exists.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { checkIntegrationConformance, type ConformanceIssue } from "@integrations/sdk";

const integrationsRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(integrationsRoot, "..");

/**
 * Not integrations: `sdk` is the contract an integration's worker half is
 * written against, `host-ui` the one its dashboard half is written against, and
 * `registry` is this package.
 */
const NOT_INTEGRATIONS = new Set(["sdk", "host-ui", "registry"]);

function packageDirectories(): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(integrationsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || NOT_INTEGRATIONS.has(entry.name)) continue;
    if (entry.name === "_fixtures") {
      for (const fixture of readdirSync(join(integrationsRoot, entry.name), {
        withFileTypes: true,
      })) {
        if (fixture.isDirectory()) found.push(join(integrationsRoot, entry.name, fixture.name));
      }
      continue;
    }
    found.push(join(integrationsRoot, entry.name));
  }
  return [...found].sort();
}

function describe(issues: readonly ConformanceIssue[]): string {
  return issues.map((issue) => `  ${issue.code} at ${issue.path}: ${issue.message}`).join("\n");
}

const directories = packageDirectories();

test("the repository holds integration packages to check", () => {
  assert.ok(
    directories.length > 0,
    "no integration package was found, so this suite proves nothing",
  );
});

for (const directory of directories) {
  const name = relative(repositoryRoot, directory).replaceAll("\\", "/");

  test(`${name} satisfies the integration contract`, async () => {
    for (const file of ["manifest.ts", "worker.ts", "package.json", "README.md"]) {
      assert.ok(existsSync(join(directory, file)), `${name} is missing ${file}`);
    }
    const { manifest } = (await import(
      pathToFileURL(join(directory, "manifest.ts")).href
    )) as { manifest: unknown };
    const { runtime } = (await import(pathToFileURL(join(directory, "worker.ts")).href)) as {
      runtime: unknown;
    };
    const issues = checkIntegrationConformance(manifest, runtime);
    assert.deepEqual(issues, [], `${name} does not satisfy the contract:\n${describe(issues)}`);
  });

  test(`${name} declares no dependency an integration may not have`, () => {
    const declared = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const workspace = Object.keys(declared.dependencies ?? {}).filter((dependency) =>
      dependency.startsWith("@shared/") || dependency.startsWith("@integrations/"),
    );
    const allowed = new Set(["@integrations/host-ui", "@integrations/sdk"]);
    assert.ok(
      workspace.includes("@integrations/sdk"),
      `${name} must depend on @integrations/sdk, which re-exports what an integration needs, including z, so a package never picks its own zod.`,
    );
    assert.deepEqual(
      workspace.filter((dependency) => !allowed.has(dependency)),
      [],
      `${name} may depend on @integrations/sdk, on @integrations/host-ui when it contributes a dashboard page, and on its provider's own packages. Nothing else in this repository is reachable from an integration.`,
    );
  });
}

/**
 * A workflow directive on its own line, matched the way the Workflow DevKit's
 * detector and `apps/worker/src/engine/discovery-root.test.ts` match it.
 */
const WORKFLOW_DIRECTIVE = /^[ \t]*(['"])use (?:step|workflow)\1;?[ \t]*$/mu;

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.[cm]?[jt]sx?$/u.test(entry.name)) found.push(path);
    }
  };
  walk(directory);
  return found.sort();
}

/**
 * Core runs every integration block inside one step it owns, and nothing an
 * integration writes may be a step or a workflow of its own. A step's identity
 * is its module path plus its function name, so a directive in a package would
 * tie every run suspended in it to where the package sits today: moving or
 * renaming the integration would strand them. The worker's discovery test
 * scans `apps/worker` only, so without this nothing would say so.
 */
for (const directory of directories) {
  const name = relative(repositoryRoot, directory).replaceAll("\\", "/");

  test(`${name} carries no workflow directive`, () => {
    const offending = sourceFiles(directory)
      .filter((path) => WORKFLOW_DIRECTIVE.test(readFileSync(path, "utf8")))
      .map((path) => relative(repositoryRoot, path).replaceAll("\\", "/"));
    assert.deepEqual(
      offending,
      [],
      `${name} carries a "use step" or "use workflow" directive. Core runs every integration block in its own generic step, and a step's identity is its module path plus its function name, so a directive here would strand every run suspended in it the day this package moved or was renamed. Write a plain async function; long or multi-phase work belongs to core, reached through a capability.`,
    );
  });
}

/**
 * Variables more than one integration may declare, each with why. Conformance
 * refuses a variable declared twice inside one manifest; across packages only
 * this test can see it, and two integrations reading one variable means an
 * operator who sets it for one has configured the other without knowing.
 */
const SHARED_ENVIRONMENT_VARIABLES: Readonly<Record<string, string>> = {
  VCS_BOT_LOGIN:
    "the automation account's login for a deployment with exactly one version control provider, read by whichever vcs integration is connected as its legacyBotLogin field",
};

test("no two integrations declare the same environment variable unless it is shared on purpose", async () => {
  const declaredBy = new Map<string, string[]>();
  for (const directory of directories) {
    const { manifest } = (await import(pathToFileURL(join(directory, "manifest.ts")).href)) as {
      manifest: { id: string; connection: { fields: readonly { env: string }[] } };
    };
    for (const { env } of manifest.connection.fields) {
      declaredBy.set(env, [...(declaredBy.get(env) ?? []), manifest.id]);
    }
  }
  const clashes = [...declaredBy]
    .filter(([env, ids]) => ids.length > 1 && !Object.hasOwn(SHARED_ENVIRONMENT_VARIABLES, env))
    .map(([env, ids]) => `${env} (${ids.join(", ")})`);
  assert.deepEqual(
    clashes,
    [],
    "two integrations read the same variable, so setting it for one configures the other. Give each its own name, or add the variable to SHARED_ENVIRONMENT_VARIABLES here with the reason both need it.",
  );
  for (const env of Object.keys(SHARED_ENVIRONMENT_VARIABLES)) {
    assert.ok((declaredBy.get(env)?.length ?? 0) > 1, `${env} is listed as shared but fewer than two integrations declare it`);
  }
});

/**
 * The floor the MCP surface redacts variable names above.
 *
 * `apps/worker/src/mcp/integration-redaction.ts` hides every declared name from
 * an agent, because a model that knows which variable to ask a person for is
 * one sentence away from a token in a chat log. It cannot hide a name short
 * enough to appear inside ordinary words without shredding every answer that
 * happens to contain those letters, and the `env` pattern above only requires
 * `^[A-Z][A-Z0-9_]*$`, so a one-letter name is legal.
 *
 * That exemption is safe only while no such name exists, which is a rule rather
 * than a hope. The number is restated and not imported, because this package
 * may not see the worker: it is `MIN_REDACTED_NAME_LENGTH`, and the two move
 * together.
 */
const MIN_REDACTED_NAME_LENGTH = 4;

for (const directory of directories) {
  const name = relative(repositoryRoot, directory).replaceAll("\\", "/");

  test(`${name} declares variable names long enough for MCP to redact`, async () => {
    const { manifest } = (await import(
      pathToFileURL(join(directory, "manifest.ts")).href
    )) as { manifest: { connection: { fields: readonly { env: string }[] } } };
    const short = manifest.connection.fields
      .map((field) => field.env)
      .filter((variable) => variable.length < MIN_REDACTED_NAME_LENGTH);
    assert.deepEqual(
      short,
      [],
      `${name} declares a variable shorter than ${MIN_REDACTED_NAME_LENGTH} characters. The MCP surface leaves such a name visible to an agent rather than redacting it inside every unrelated word; give the field a longer variable name.`,
    );
  });
}
