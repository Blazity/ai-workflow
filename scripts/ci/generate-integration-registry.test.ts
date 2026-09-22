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
  /** The pages the manifest declares, which is what a dashboard entry serves. */
  pages?: Array<{ id: string; label: string }>;
  /** `null` writes no dashboard.tsx, whatever the pages say. */
  dashboard?: string | null;
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
  pages: [${(files.pages ?? []).map((page) => `{ id: "${page.id}", label: "${page.label}" }`).join(", ")}],
  health: [{ id: "auth", label: "Auth", description: "d", critical: true }],
});
`,
  );
  if (files.dashboard !== null && (files.dashboard !== undefined || (files.pages ?? []).length > 0)) {
    await writeFile(
      join(absolute, "dashboard.tsx"),
      files.dashboard ??
        `import { defineIntegrationDashboard } from "@integrations/host-ui";
import type { manifest } from "./manifest";

export const dashboard = defineIntegrationDashboard<typeof manifest>({
  pages: { ${(files.pages ?? []).map((page) => `${page.id}: () => null`).join(", ")} },
});
`,
    );
  }
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

/**
 * The flow bundle evaluates manifests inside the Workflow DevKit's VM, which
 * hands them `process` as `{ env }` and no `Buffer`, timers, `fetch` or
 * `AbortSignal` (@workflow/core 4.8.0, dist/vm/index.js). Conformance runs in
 * Node and the typecheck sees @types/node, so both pass; the deployed workflow
 * throws a ReferenceError. The generator is the one reader that could say so.
 */
test("a manifest that uses a Node global is refused, because the flow bundle's VM has none", async (t) => {
  for (const [label, expression, file] of [
    ["Buffer", 'Buffer.from("abc").toString("base64")', "manifest"],
    ["process", "process.cwd()", "manifest"],
    ["performance one file away", "String(performance.now())", "helper"],
  ] as const) {
    const root = await fixtureRoot("gen-integrations-global");
    t.after(() => rm(root, { recursive: true, force: true }));
    const value = file === "manifest" ? expression : "helperValue";
    await writeIntegration(root, "alpha", {
      id: "alpha",
      manifest: `import { defineIntegration } from "@integrations/sdk";
${file === "helper" ? 'import { helperValue } from "./helper";\n' : ""}
export const manifest = defineIntegration({
  id: "alpha",
  name: "Alpha",
  description: ${value},
  connection: { fields: [] },
  capabilities: [],
  blocks: [],
  pages: [],
  health: [{ id: "auth", label: "Auth", description: "d", critical: true }],
});
`,
    });
    if (file === "helper") {
      await writeFile(join(root, "integrations/alpha/helper.ts"), `export const helperValue = ${expression};\n`);
    }
    assert.throws(
      () => readIntegrations({ root }),
      (error: Error) => error.message.includes(label.split(" ")[0]!) && /flow bundle/u.test(error.message),
      label,
    );
  }
});

test("a manifest may name what the VM does give it, and may bind a Node global's name locally", async (t) => {
  const root = await fixtureRoot("gen-integrations-global-ok");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeIntegration(root, "alpha", {
    id: "alpha",
    manifest: `import { defineIntegration } from "@integrations/sdk";

type Payload = { buffer: Buffer };
const process = (value: string) => value.trim();
const docs = new URL("https://alpha.test/docs").toString();
const encoded = btoa(JSON.stringify({ at: Math.max(1, 2) }));

export const manifest = defineIntegration({
  id: "alpha",
  name: "Alpha",
  description: process(docs + encoded),
  connection: { fields: [] },
  capabilities: [],
  blocks: [],
  pages: [],
  health: [{ id: "auth", label: "Auth", description: "d", critical: true }],
});
export type { Payload };
`,
  });
  assert.deepEqual(readIntegrations({ root }).map((record) => record.id), ["alpha"]);
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

test("an integration's pages become a dashboard registry keyed by id", async (t) => {
  const root = await fixtureRoot("gen-integrations-dashboard");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeIntegration(root, "alpha", {
    id: "alpha",
    pages: [{ id: "overview", label: "Overview" }],
  });
  // An integration with no pages contributes no screen and is simply absent,
  // rather than present with an empty object for the route to look through.
  await writeIntegration(root, "beta", { id: "beta" });

  const generated = renderGeneratedFiles({ root });
  assert.match(generated.dashboards, /"alpha": \{/u);
  assert.match(generated.dashboards, /pages: \["overview"\]/u);
  assert.doesNotMatch(generated.dashboards, /beta/);
  // The module is behind a loader and nothing imports it at the top level: a
  // static import would run the top level of every shipped integration on the
  // first load of any integration route, connected or not.
  assert.match(generated.dashboards, /load: \(\) => import\("\.\.\/alpha\/dashboard"\)/u);
  assert.doesNotMatch(
    generated.dashboards,
    /^import \{ dashboard/mu,
    "an integration's dashboard entry must not be imported at the top of the registry",
  );
  // And the React half stays out of the two registries that are read where
  // there is no React: the worker's, and the flow bundle's.
  assert.doesNotMatch(generated.manifests, /from "[^"]*dashboard"/u);
  assert.doesNotMatch(generated.runtimes, /from "[^"]*dashboard"/u);
});

test("a declared page with no component is refused, naming the page", async (t) => {
  // Otherwise the tab is in the sidebar and renders nothing, which is the one
  // failure a reader would blame on the cockpit rather than the integration.
  const root = await fixtureRoot("gen-integrations-page-nocomponent");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeIntegration(root, "alpha", {
    id: "alpha",
    pages: [{ id: "overview", label: "Overview" }],
    dashboard: null,
  });
  assert.throws(() => readIntegrations({ root }), /declares the page "overview".*dashboard\.tsx/su);
});

test("a dashboard entry for an integration with no pages is refused", async (t) => {
  // Nothing in the cockpit can reach it: the tabs are built from the manifest.
  const root = await fixtureRoot("gen-integrations-page-undeclared");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeIntegration(root, "alpha", {
    id: "alpha",
    dashboard: "export const dashboard = { pages: {} };\n",
  });
  assert.throws(() => readIntegrations({ root }), /declares no pages/u);
});

test("a dashboard entry that reads the deployment's environment is refused", async (t) => {
  // Not an import, so no specifier rule can see it, and the one reach that
  // needs no dependency at all: a Server Component in our process would get
  // WORKER_BASE_URL and every other variable this deployment runs with.
  const root = await fixtureRoot("gen-integrations-dashboard-env");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeIntegration(root, "alpha", {
    id: "alpha",
    pages: [{ id: "overview", label: "Overview" }],
    dashboard: 'export const dashboard = { pages: { overview: () => process.env.WORKER_BASE_URL } };\n',
  });
  assert.throws(() => readIntegrations({ root }), /may not read process\.env/u);
});

test("a helper one file away cannot read it either", async (t) => {
  const root = await fixtureRoot("gen-integrations-dashboard-env-helper");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeIntegration(root, "alpha", {
    id: "alpha",
    pages: [{ id: "overview", label: "Overview" }],
    dashboard: 'import { where } from "./where";\nexport const dashboard = { pages: { overview: where } };\n',
  });
  await writeFile(
    join(root, "integrations/alpha/where.ts"),
    "export const where = () => process.env.WORKER_BASE_URL;\n",
  );
  assert.throws(() => readIntegrations({ root }), /where\.ts: a dashboard entry may not read process\.env/u);
});

test("the host UI package is not read as an integration", async (t) => {
  // It sits under integrations/ because it is a contract with integrations,
  // not because it is one. A directory with no manifest is refused rather than
  // skipped, so forgetting to name it here is a generator that cannot run.
  const root = await fixtureRoot("gen-integrations-host-ui");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "integrations/host-ui"), { recursive: true });
  await writeFile(join(root, "integrations/host-ui/index.ts"), "export const Page = 1;\n");
  await writeIntegration(root, "alpha", { id: "alpha" });
  assert.deepEqual(
    readIntegrations({ root }).map((entry) => entry.id),
    ["alpha"],
  );
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
