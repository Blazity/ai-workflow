import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  generateIntegrationRegistry,
  readIntegrations,
  renderGeneratedFiles,
  staleGeneratedFiles,
} from "../gates/generate-integration-registry.js";

const execFileAsync = promisify(execFile);
const generatorPath = join(
  process.cwd(),
  "scripts/gates/generate-integration-registry.ts",
);

/**
 * A throwaway workspace shaped like this repository: one core block (so the
 * generator has a core block type to collide against), the SDK directory and
 * the registry directory it writes into, and whatever integrations the case
 * needs. Nothing here resolves `@integrations/sdk`: the generator reads the
 * manifests rather than importing them, which is what lets a fixture be four
 * files instead of an install.
 */
async function fixtureRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), `.${name}-`));
  await mkdir(join(root, "apps/worker/src/engine/blocks/arthur-injection-check"), {
    recursive: true,
  });
  await writeFile(
    join(root, "apps/worker/src/engine/blocks/arthur-injection-check/manifest.ts"),
    `import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

const paramsSchema = z.object({}).strict();

export const manifest = {
  type: "arthur_injection_check",
  paramsSchema,
  contract: { category: "action", ports: ["out"], allowsFailurePort: true },
  ui: { group: "utility", label: "Check", description: "Core check", glyph: "C", color: "#64748B", softColor: "#EEF1F5" },
  defaults: {},
  inputs: {},
  execution: "map",
} satisfies BlockManifest;
`,
  );
  await writeFile(
    join(root, "apps/worker/src/engine/blocks/arthur-injection-check/execute.ts"),
    'export const execute = async () => ({ kind: "next" });\n',
  );
  await mkdir(join(root, "integrations/sdk"), { recursive: true });
  await writeFile(join(root, "integrations/sdk/index.ts"), "export const z = 1;\n");
  await mkdir(join(root, "integrations/registry"), { recursive: true });
  return root;
}

type IntegrationFiles = {
  id: string;
  blocks?: string[];
  manifest?: string;
  worker?: string | null;
  readme?: string | null;
  packageName?: string | null;
};

async function writeIntegration(
  root: string,
  directory: string,
  files: IntegrationFiles,
): Promise<void> {
  const absolute = join(root, "integrations", directory);
  await mkdir(absolute, { recursive: true });
  const blocks = files.blocks ?? [`${files.id}_ping`];
  await writeFile(
    join(absolute, "manifest.ts"),
    files.manifest ??
      `import { defineIntegration, defineIntegrationBlock, z } from "@integrations/sdk";

${blocks
  .map(
    (type, index) => `const block${index} = defineIntegrationBlock({
  type: "${type}",
  paramsSchema: z.object({}),
  contract: { ports: ["out"], allowsFailurePort: false },
  ui: { label: "B", description: "B", glyph: "B", color: "#000000", softColor: "#FFFFFF" },
  output: { properties: {}, statusVariants: ["ok"] },
});`,
  )
  .join("\n\n")}

export const manifest = defineIntegration({
  id: "${files.id}",
  name: "${files.id}",
  description: "d",
  connection: { fields: [] },
  capabilities: [],
  blocks: [${blocks.map((_, index) => `block${index}`).join(", ")}],
  pages: [],
  health: [{ id: "auth", label: "Auth", description: "d", critical: true }],
});
`,
  );
  if (files.worker !== null) {
    await writeFile(
      join(absolute, "worker.ts"),
      files.worker ??
        `import { defineIntegrationRuntime } from "@integrations/sdk";
import { manifest } from "./manifest";

export const runtime = defineIntegrationRuntime(manifest, {} as never);
`,
    );
  }
  if (files.readme !== null) await writeFile(join(absolute, "README.md"), files.readme ?? "# x\n");
  if (files.packageName !== null) {
    await writeFile(
      join(absolute, "package.json"),
      `${JSON.stringify({ name: files.packageName ?? `@integrations/${files.id}` }, null, 2)}\n`,
    );
  }
}

test("an integration folder becomes a registry entry, and removing the folder removes it", async (t) => {
  const root = await fixtureRoot("gen-integrations-add");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeIntegration(root, "alpha", { id: "alpha" });
  await writeIntegration(root, "beta", { id: "beta" });

  const added = renderGeneratedFiles({ root });
  assert.match(added.manifests, /from "\.\.\/alpha\/manifest"/);
  assert.match(added.manifests, /from "\.\.\/beta\/manifest"/);
  assert.match(added.runtimes, /from "\.\.\/alpha\/worker"/);

  await rm(join(root, "integrations/beta"), { recursive: true });
  const removed = renderGeneratedFiles({ root });
  assert.match(removed.manifests, /from "\.\.\/alpha\/manifest"/);
  assert.doesNotMatch(removed.manifests, /beta/);
  assert.doesNotMatch(removed.runtimes, /beta/);
});

test("the registry lists integrations in id order whatever order the directories are read in", async (t) => {
  const root = await fixtureRoot("gen-integrations-order");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeIntegration(root, "zulu", { id: "zulu" });
  await writeIntegration(root, "alpha", { id: "alpha" });

  assert.deepEqual(
    readIntegrations({ root }).map((entry) => entry.id),
    ["alpha", "zulu"],
  );
});

test("--check fails while the checked-in registry is stale and passes once it is regenerated", async (t) => {
  const root = await fixtureRoot("gen-integrations-check");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeIntegration(root, "alpha", { id: "alpha" });
  generateIntegrationRegistry({ root });
  assert.deepEqual(staleGeneratedFiles({ root }), []);

  await writeIntegration(root, "beta", { id: "beta" });
  assert.notDeepEqual(staleGeneratedFiles({ root }), []);

  const stale = await execFileAsync(process.execPath, [
    "--import",
    "tsx",
    generatorPath,
    "--root",
    root,
    "--check",
  ]).then(
    () => ({ code: 0, stderr: "" }),
    (error: { code: number; stderr: string }) => error,
  );
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /manifests\.generated\.ts/);

  generateIntegrationRegistry({ root });
  await execFileAsync(process.execPath, [
    "--import",
    "tsx",
    generatorPath,
    "--root",
    root,
    "--check",
  ]);
});

test("a fixture integration reaches the registry only when the fixture flag is set", async (t) => {
  const root = await fixtureRoot("gen-integrations-fixture");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeIntegration(root, "alpha", { id: "alpha" });
  await writeIntegration(root, "_fixtures/demo", { id: "demo" });

  const shipped = renderGeneratedFiles({ root });
  assert.doesNotMatch(shipped.manifests, /demo/);
  assert.doesNotMatch(shipped.runtimes, /demo/);

  const withFixtures = renderGeneratedFiles({ root, includeFixtures: true });
  assert.match(withFixtures.manifests, /from "\.\.\/_fixtures\/demo\/manifest"/);
  assert.match(withFixtures.runtimes, /from "\.\.\/_fixtures\/demo\/worker"/);
});

test("the build flag is the only difference between the two registries", async (t) => {
  const root = await fixtureRoot("gen-integrations-flag");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeIntegration(root, "alpha", { id: "alpha" });
  await writeIntegration(root, "_fixtures/demo", { id: "demo" });

  const run = (env: NodeJS.ProcessEnv) =>
    execFileAsync(process.execPath, ["--import", "tsx", generatorPath, "--root", root], {
      env: { ...process.env, ...env },
    });
  const registry = () => readFile(join(root, "integrations/registry/manifests.generated.ts"), "utf8");

  await run({ INTEGRATION_FIXTURES: "" });
  const shipped = await registry();
  await run({ INTEGRATION_FIXTURES: "1" });
  const withFixtures = await registry();
  await run({ INTEGRATION_FIXTURES: "" });

  assert.doesNotMatch(shipped, /demo/);
  assert.match(withFixtures, /_fixtures\/demo\/manifest/);
  // The flag also declares what it let in, so the shipped registry can tell a
  // fixture apart from something we actually ship. Empty without the flag, and
  // exactly the fixtures with it.
  assert.match(shipped, /generatedIntegrationFixtureIds: readonly string\[\] = \[\];/u);
  assert.match(withFixtures, /generatedIntegrationFixtureIds: readonly string\[\] = \["demo"\];/u);
  // Everything else is identical: erase the fixture's import, its entry in the
  // list and the declaration above, and the two files are the same bytes.
  const withoutFixtures = withFixtures
    .replace(/^.*_fixtures.*$\n?/gmu, "")
    .replace(/^ {2}demo,$\n?/gmu, "")
    .replace(/= \["demo"\];$/mu, "= [];");
  assert.equal(withoutFixtures, shipped);
  assert.equal(await registry(), shipped);
});

test("the template is never registered, so copying it does not ship it", async (t) => {
  const root = await fixtureRoot("gen-integrations-template");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeIntegration(root, "alpha", { id: "alpha" });
  await writeIntegration(root, "_template", { id: "example" });

  for (const includeFixtures of [false, true]) {
    assert.doesNotMatch(renderGeneratedFiles({ root, includeFixtures }).manifests, /example/);
  }
});

test("the manifest registry never imports a worker entry, so the browser and flow bundles stay free of Node", async (t) => {
  const root = await fixtureRoot("gen-integrations-split");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeIntegration(root, "alpha", { id: "alpha" });

  const generated = renderGeneratedFiles({ root });
  assert.doesNotMatch(generated.manifests, /\/worker"/);
  assert.match(generated.runtimes, /\/worker"/);
});

test("an integration block type that a core block already uses is refused, naming both", async (t) => {
  const root = await fixtureRoot("gen-integrations-collision");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeIntegration(root, "arthur", {
    id: "arthur",
    blocks: ["arthur_injection_check"],
  });

  assert.throws(
    () => readIntegrations({ root }),
    /arthur_injection_check[\s\S]*core block/i,
  );
});

test("two integrations claiming the same block type are refused", async (t) => {
  const root = await fixtureRoot("gen-integrations-duplicate");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeIntegration(root, "alpha", { id: "alpha", blocks: ["alpha_ping"] });
  await writeIntegration(root, "beta", { id: "beta", blocks: ["alpha_ping"] });

  assert.throws(() => readIntegrations({ root }), /alpha_ping/);
});

test("a block type that does not name its integration is refused", async (t) => {
  const root = await fixtureRoot("gen-integrations-prefix");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeIntegration(root, "alpha", { id: "alpha", blocks: ["ping"] });

  assert.throws(() => readIntegrations({ root }), /"ping" must start with "alpha_"/);
});

test("two integrations claiming the same id are refused, naming both directories", async (t) => {
  const root = await fixtureRoot("gen-integrations-duplicate-id");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeIntegration(root, "alpha", { id: "alpha", blocks: ["alpha_one"] });
  await writeIntegration(root, "alpha-fork", {
    id: "alpha",
    blocks: ["alpha_two"],
    packageName: "@integrations/alpha",
  });

  assert.throws(
    () => readIntegrations({ root }),
    /claim the id "alpha"[\s\S]*integrations\/alpha[\s\S]*integrations\/alpha-fork/,
  );
});

test("a manifest that reaches a Node module is refused, because the flow bundle would fail only on Vercel", async (t) => {
  const root = await fixtureRoot("gen-integrations-node");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeIntegration(root, "alpha", {
    id: "alpha",
    manifest: `import { readFileSync } from "node:fs";
import { defineIntegration } from "@integrations/sdk";

void readFileSync;

export const manifest = defineIntegration({
  id: "alpha",
  name: "Alpha",
  description: "d",
  connection: { fields: [] },
  capabilities: [],
  blocks: [],
  pages: [],
  health: [{ id: "auth", label: "Auth", description: "d", critical: true }],
});
`,
  });

  assert.throws(() => readIntegrations({ root }), /node:fs/);
});

test("a manifest that hides a Node module behind a file of its own is refused too", async (t) => {
  const root = await fixtureRoot("gen-integrations-node-indirect");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeIntegration(root, "alpha", {
    id: "alpha",
    manifest: `import { defineIntegration } from "@integrations/sdk";
import { blocks } from "./blocks";

export const manifest = defineIntegration({
  id: "alpha",
  name: "Alpha",
  description: "d",
  connection: { fields: [] },
  capabilities: [],
  blocks,
  pages: [],
  health: [{ id: "auth", label: "Auth", description: "d", critical: true }],
});
`,
  });
  await writeFile(
    join(root, "integrations/alpha/blocks.ts"),
    'import { createHash } from "node:crypto";\n\nvoid createHash;\nexport const blocks = [];\n',
  );

  assert.throws(() => readIntegrations({ root }), /node:crypto/);
});

test("an integration without a worker entry is refused, because nothing could run it", async (t) => {
  const root = await fixtureRoot("gen-integrations-no-worker");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeIntegration(root, "alpha", { id: "alpha", worker: null });

  assert.throws(() => readIntegrations({ root }), /worker\.ts/);
});

test("an integration without a README is refused, because the next developer reads it first", async (t) => {
  const root = await fixtureRoot("gen-integrations-no-readme");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeIntegration(root, "alpha", { id: "alpha", readme: null });

  assert.throws(() => readIntegrations({ root }), /README\.md/);
});

test("a package name that disagrees with the manifest id is refused", async (t) => {
  const root = await fixtureRoot("gen-integrations-name");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeIntegration(root, "alpha", { id: "alpha", packageName: "@integrations/alfa" });

  assert.throws(() => readIntegrations({ root }), /@integrations\/alpha/);
});

test("a directory under integrations with no manifest is refused rather than skipped", async (t) => {
  const root = await fixtureRoot("gen-integrations-empty");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeIntegration(root, "alpha", { id: "alpha" });
  await mkdir(join(root, "integrations/halfway"), { recursive: true });
  await writeFile(join(root, "integrations/halfway/worker.ts"), "export const runtime = 1;\n");

  assert.throws(() => readIntegrations({ root }), /halfway[\s\S]*manifest\.ts/);
});

test("the generated files carry the header that says not to edit them", async (t) => {
  const root = await fixtureRoot("gen-integrations-header");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeIntegration(root, "alpha", { id: "alpha" });
  generateIntegrationRegistry({ root });

  for (const file of ["manifests.generated.ts", "runtimes.generated.ts"]) {
    const content = await readFile(join(root, "integrations/registry", file), "utf8");
    assert.match(content, /THIS FILE IS GENERATED/);
    assert.match(content, /gen:integrations/);
  }
});
