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
import {
  checkIntegrationConformance,
  RESERVED_ENVIRONMENT_VARIABLES,
  type ConformanceIssue,
} from "@integrations/sdk";

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

test("the reserved environment variables hold no name an integration owns", () => {
  const owned = RESERVED_ENVIRONMENT_VARIABLES.filter((variable) =>
    variable !== "VCS_BOT_LOGIN" &&
    directories.some((directory) =>
      readFileSync(join(directory, "manifest.ts"), "utf8").includes(`"${variable}"`),
    ),
  );
  assert.deepEqual(
    owned,
    [],
    "an integration declares an environment variable core reads for itself; conformance should have refused it",
  );
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
