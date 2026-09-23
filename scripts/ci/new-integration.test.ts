import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { MENTION_RULE } from "../gates/core-references.mjs";
import { readIntegrations } from "../gates/generate-integration-registry.js";
import { createIntegration, parseArguments } from "../gates/new-integration.js";

/**
 * What `pnpm run new:integration` promises: a package that passes the
 * generator, the typecheck and the conformance check before anybody has edited
 * a line of it, and a refusal with a sentence for every id that would fail one
 * of them later.
 *
 * The output is written under the template's own `node_modules`, which is
 * ignored by git and is where `@integrations/sdk`, `@integrations/host-ui`,
 * React and TypeScript already resolve, so the package can be compiled and
 * imported without an install. The template, the SDK, the generator and the
 * core source it is checked against are the real ones.
 */
const root = process.cwd();
const templateDirectory = join(root, "integrations/_template");
const templateRequire = createRequire(join(templateDirectory, "package.json"));

async function scratch(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(templateDirectory, "node_modules/.scaffold-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function filesOf(directory: string): string[] {
  const found: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else found.push(relative(directory, path));
    }
  };
  walk(directory);
  return found.sort();
}

const TEMPLATE_NAMES = /@integrations\/example|"example"|\bexample_|\bEXAMPLE_|\bExample\b/u;

test("a new integration is the template with the template's names replaced", async (t) => {
  const directory = await scratch(t);
  const target = join(directory, "quokka");

  const result = await createIntegration({ root, id: "quokka", name: "Quokka Cloud", target });

  assert.deepEqual(result.files, filesOf(templateDirectory));
  assert.deepEqual(filesOf(target), filesOf(templateDirectory));
  for (const file of result.files) {
    const text = readFileSync(join(target, file), "utf8");
    assert.doesNotMatch(text, TEMPLATE_NAMES, `${file} still carries a name of the template`);
  }
  const packageJson = JSON.parse(readFileSync(join(target, "package.json"), "utf8")) as {
    name: string;
    description: string;
  };
  assert.equal(packageJson.name, "@integrations/quokka");
  assert.match(packageJson.description, /^Quokka Cloud: /u);
  const manifest = readFileSync(join(target, "manifest.ts"), "utf8");
  assert.match(manifest, /id: "quokka"/u);
  assert.match(manifest, /name: "Quokka Cloud"/u);
  assert.match(manifest, /type: "quokka_lookup"/u);
  assert.match(manifest, /env: "QUOKKA_API_TOKEN"/u);
  // The block's palette tile carries the integration's initial, not the
  // template's "E", which every scaffolded package used to ship.
  assert.match(manifest, /glyph: "Q"/u);
  assert.match(readFileSync(join(target, "worker.ts"), "utf8"), /quokka_lookup: async/u);
  assert.match(readFileSync(join(target, "README.md"), "utf8"), /^# Quokka Cloud$/mu);
});

test("what it writes passes the generator, the typecheck and conformance untouched", async (t) => {
  const directory = await scratch(t);
  const target = join(directory, "quokka");
  await createIntegration({ root, id: "quokka", target });

  // The generator's own reading of an integrations directory: the manifest is
  // pure data, the dashboard reads no environment, the block type and its one
  // port are the shape a stored definition can carry, and the package name
  // matches the id.
  const records = readIntegrations({ root, integrationsRoot: directory });
  assert.deepEqual(
    records.map((record) => ({ id: record.id, blocks: record.blockTypes, pages: record.pageIds })),
    [{ id: "quokka", blocks: ["quokka_lookup"], pages: ["overview"] }],
  );

  const tsc = spawnSync(
    process.execPath,
    [templateRequire.resolve("typescript/bin/tsc"), "--noEmit", "-p", join(target, "tsconfig.json")],
    { encoding: "utf8" },
  );
  assert.equal(tsc.status, 0, `the new package does not typecheck:\n${tsc.stdout}${tsc.stderr}`);

  const sdk = (await import(
    pathToFileURL(templateRequire.resolve("@integrations/sdk")).href
  )) as { checkIntegrationConformance: (manifest: unknown, runtime: unknown) => unknown[] };
  const { manifest } = (await import(pathToFileURL(join(target, "manifest.ts")).href)) as {
    manifest: unknown;
  };
  const { runtime } = (await import(pathToFileURL(join(target, "worker.ts")).href)) as {
    runtime: unknown;
  };
  assert.deepEqual(sdk.checkIntegrationConformance(manifest, runtime), []);

  // The test script it carries runs the test it carries, nested files included.
  const script = (JSON.parse(readFileSync(join(target, "package.json"), "utf8")) as {
    scripts: { test: string };
  }).scripts.test;
  const patterns = [...script.matchAll(/"([^"]+)"/gu)].map((match) => match[1]!);
  // Without this suite's own runner context, which would take the child's
  // report instead of letting it print one.
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  const run = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-reporter=spec", ...patterns], {
    cwd: target,
    encoding: "utf8",
    env,
  });
  assert.equal(run.status, 0, `the new package's own tests fail:\n${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /^ℹ pass [1-9]/mu, "the new package's test script ran no test");
});

test("an id that is not 3 to 32 lowercase letters and digits is refused before anything is written", async (t) => {
  const directory = await scratch(t);
  for (const id of ["Quokka", "qk", "9lives", "quokka_cloud", "quokka-cloud"]) {
    const target = join(directory, id);
    await assert.rejects(createIntegration({ root, id, target }), /3 to 32 lowercase letters and digits/u);
    assert.equal(existsSync(target), false, `${id} left a directory behind`);
  }
});

test("an id core already uses is refused with the SDK's own list", async (t) => {
  const directory = await scratch(t);
  await assert.rejects(
    createIntegration({ root, id: "memory", target: join(directory, "memory") }),
    /"memory" is a word core already uses/u,
  );
});

test("an id that already names an integration is refused", async (t) => {
  const directory = await scratch(t);
  await assert.rejects(
    createIntegration({ root, id: "slack", target: join(directory, "slack") }),
    /integrations\/slack already exists/u,
  );
});

test("an id core source already spells is refused, naming the files and the gate's own rule, because the core-reference gate would fail on them", async (t) => {
  const directory = await scratch(t);
  await assert.rejects(createIntegration({ root, id: "acme", target: join(directory, "acme") }), (error: Error) => {
    assert.match(
      error.message,
      /core spells "acme" in \d+ files? that no allowlist row covers:\n {2}(?:apps|packages)\/[\s\S]*Nothing was written\./u,
    );
    assert.ok(error.message.includes(MENTION_RULE), "the refusal states the rule the gate applies, word for word");
    return true;
  });
});

/**
 * The scaffold asks the core-reference gate's own question, so it refuses
 * exactly what the gate would fail on once the package exists: a spelling no
 * allowlist row covers. A CSS keyword inside a className or style attribute is
 * not a spelling, and a row somebody added with a reason clears its file.
 */
test("an id core spells only as presentation or under an allowlist row is accepted, and the rest is named", async (t) => {
  const directory = await scratch(t);
  // Core is what git would carry, so the scratch core sits in the checkout,
  // outside every ignored directory, and goes away with the test.
  const coreDirectory = await mkdtemp(join(root, ".scaffold-core-"));
  t.after(() => rm(coreDirectory, { recursive: true, force: true }));
  const core = relative(root, coreDirectory);
  writeFileSync(
    join(root, core, "bar.tsx"),
    'export const Bar = () => <div className="ease-quokka" style={{ animation: "x 1s quokka" }} />;\n',
  );
  writeFileSync(join(root, core, "sample.ts"), 'export const rows = [{ src: "quokka" }];\n');
  const config = (rows: unknown[]) => {
    const path = join(directory, `core-references-${rows.length}.json`);
    writeFileSync(path, JSON.stringify({ coreRoots: [core], exclude: [], plannedIntegrations: {}, allowlist: rows }));
    return path;
  };

  const refused = createIntegration({
    root,
    id: "quokka",
    target: join(directory, "refused"),
    coreReferencesPath: config([]),
  });
  await assert.rejects(refused, (error: Error) => {
    assert.match(error.message, /sample\.ts/u);
    assert.doesNotMatch(error.message, /bar\.tsx/u, "a className or style attribute is presentation");
    assert.match(error.message, /allowlist row/u);
    return true;
  });
  assert.equal(existsSync(join(directory, "refused")), false);

  const row = { ids: ["quokka"], stage: "kept", reason: "sample data", paths: [`${core}/sample.ts`] };
  const created = await createIntegration({
    root,
    id: "quokka",
    target: join(directory, "accepted"),
    coreReferencesPath: config([row]),
  });
  assert.equal(created.directory, join(directory, "accepted"));
});

test("a display name may carry the word the template uses for its own name", async (t) => {
  const directory = await scratch(t);
  const target = join(directory, "quokka");
  const result = await createIntegration({ root, id: "quokka", name: "Example Co", target });
  assert.equal(result.name, "Example Co");
  assert.match(readFileSync(join(target, "README.md"), "utf8"), /^# Example Co$/mu);
  assert.match(readFileSync(join(target, "manifest.ts"), "utf8"), /name: "Example Co"/u);
});

test("the id is the first argument that is not a flag or a flag's value, even when the name spells it", () => {
  assert.deepEqual(parseArguments(["zzprobe", "--name", "zzprobe"]), { id: "zzprobe", name: "zzprobe" });
  assert.deepEqual(parseArguments(["--name", "Quokka", "quokka"]), { id: "quokka", name: "Quokka" });
  assert.deepEqual(parseArguments(["--root", "/tmp/x", "quokka"]), { id: "quokka", root: "/tmp/x" });
  assert.deepEqual(parseArguments(["--name", "Quokka"]), { name: "Quokka" });
});

test("a display name that cannot sit inside a string literal is refused", async (t) => {
  const directory = await scratch(t);
  await assert.rejects(
    createIntegration({ root, id: "quokka", name: 'Quokka "Cloud"', target: join(directory, "quokka") }),
    /display name/u,
  );
});
