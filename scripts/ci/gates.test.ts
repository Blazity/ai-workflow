import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  classify,
  crossClusterDeepImport,
  deepImportRegression,
  hasFileCycles,
  normalizeFileCycles,
} from "../gates/boundaries.mjs";

const boundaryFixture = (root: string): string => {
    const source = join(root, "apps/worker/src");
    mkdirSync(join(source, "routes"), { recursive: true });
    mkdirSync(join(source, "db"), { recursive: true });
    writeFileSync(join(source, "db/client.ts"), "export const db = 1;\n");
    writeFileSync(join(source, "routes/entry.ts"), 'import { db } from "../db/client.js";\nvoid db;\n');
    return root;
  },
  gateFailure = 1,
  gateSuccess = 0,
  // Writes a throwaway workspace from a path-to-contents map and returns its root.
  makeDepsRoot = (prefix: string, files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), prefix));
    for (const [file, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), contents);
    }
    return root;
  },
  repoRoot = resolve(import.meta.dirname, "../.."),
  standaloneGateRoot = (root: string): string => {
    cpSync(join(repoRoot, "scripts/gates"), join(root, "scripts/gates"), { recursive: true });
    return boundaryFixture(root);
  };

function gate(name: string, args: string[] = [], root: string = repoRoot) {
  return spawnSync(process.execPath, [join(root, "scripts/gates", name), ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

function docsStatusFixture(files: Record<string, string>): string {
  const root = makeDepsRoot("docs-status-fixture-", files);
  mkdirSync(join(root, "scripts/gates"), { recursive: true });
  cpSync(
    join(repoRoot, "scripts/gates/docs-status.mjs"),
    join(root, "scripts/gates/docs-status.mjs"),
  );
  return root;
}

function filesNamed(root: string, name: string): string[] {
  const found: string[] = [];
  const ignored = new Set([".git", "node_modules", ".next", ".output", ".nitro"]);
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === name) found.push(path);
    }
  };
  visit(root);
  return found;
}

test("docs-status rejects a document with a bad header", () => {
  const result = gate(
    "docs-status.mjs",
    [],
    docsStatusFixture({ "README.md": "# Missing status\n" }),
  );
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(result.stderr, /README\.md: first line must be/);
});

test("docs-status rejects a stale current document", () => {
  const result = gate(
    "docs-status.mjs",
    [],
    docsStatusFixture({
      "README.md": "Status: current\nLast-verified: 2020-01-01\n\n# Old\n",
    }),
  );
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(result.stderr, /README\.md: Status is current but Last-verified/);
});

test("docs-status rejects a current document that is unreachable", () => {
  const result = gate(
    "docs-status.mjs",
    [],
    docsStatusFixture({
      "README.md": "Status: current\nLast-verified: 2026-09-11\n\n# Readme\n",
      "docs/hidden.md": "Status: current\nLast-verified: 2026-09-11\n\n# Hidden\n",
    }),
  );
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(result.stderr, /docs\/hidden\.md: Status is current but nothing reaches it/);
});

test("every Claude bridge starts by loading AGENTS.md", () => {
  const bridges = filesNamed(repoRoot, "CLAUDE.md");
  assert.deepEqual(
    new Set(bridges.map((path) => path.slice(repoRoot.length + 1))),
    new Set(["CLAUDE.md", "apps/dashboard/CLAUDE.md", "apps/worker/CLAUDE.md"]),
  );
  for (const bridge of bridges) {
    assert.equal(readFileSync(bridge, "utf8").split("\n", 1)[0], "@AGENTS.md", bridge);
  }
});

test("the boundary gate is a hard zero and reports file changes", async () => {
  const recorded = gate("boundaries.mjs");
  assert.equal(recorded.status, 0, recorded.stderr || recorded.stdout);

  const root = await mkdtemp(join(tmpdir(), "boundary-gate-"));
  const source = join(root, "apps/worker/src");
  boundaryFixture(root);

  const common = ["--root", root];
  const before = gate("boundaries.mjs", common);
  assert.equal(before.status, gateFailure, before.stderr || before.stdout);
  assert.match(before.stdout, /app->db\s+1/u);

  await rename(join(source, "routes/entry.ts"), join(source, "routes/renamed.ts"));
  const after = gate("boundaries.mjs", common);
  assert.equal(after.status, gateFailure, after.stderr || after.stdout);
  assert.match(after.stdout, /renamed\.ts -> apps\/worker\/src\/db\/client\.ts/u);

  await writeFile(join(source, "routes/second.ts"), 'import { db } from "../db/client.js";\nvoid db;\n');
  const regression = gate("boundaries.mjs", common);
  assert.equal(regression.status, gateFailure, regression.stderr || regression.stdout);
  assert.match(regression.stdout, /app->db\s+2/u);
  assert.match(
    regression.stdout,
    /apps\/worker\/src\/routes\/renamed\.ts -> apps\/worker\/src\/db\/client\.ts  \(app->db\)/u,
  );
  assert.match(
    regression.stdout,
    /apps\/worker\/src\/routes\/second\.ts -> apps\/worker\/src\/db\/client\.ts  \(app->db\)/u,
  );
});

test("the boundary gate prints forbidden edges on request", async () => {
  const root = await mkdtemp(join(tmpdir(), "boundary-print-edges-gate-"));
  boundaryFixture(root);

  const printed = gate("boundaries.mjs", ["--root", root, "--print-edges"]);
  assert.equal(printed.status, gateFailure, printed.stderr || printed.stdout);
  assert.match(
    printed.stdout,
    /apps\/worker\/src\/routes\/entry\.ts -> apps\/worker\/src\/db\/client\.ts  \(app->db\)/u,
  );
});

test("the boundary gate rejects retired baseline options", async () => {
  const root = await mkdtemp(join(tmpdir(), "boundary-options-gate-"));
  boundaryFixture(root);

  for (const option of ["--baseline", "--update-baseline"]) {
    const result = gate("boundaries.mjs", ["--root", root, option]);
    assert.equal(result.status, gateFailure, result.stderr || result.stdout);
    assert.match(result.stderr, /Unknown or incomplete argument/u);
  }
});

test("file cycle normalization dedupes reports and detects any cycle", () => {
  const report = {
    modules: [
      {
        source: "src/alpha.ts",
        dependencies: [{
          circular: true,
          cycle: [{ name: "src/beta.ts" }, { name: "src/alpha.ts" }],
        }],
      },
      {
        source: "src/beta.ts",
        dependencies: [{
          circular: true,
          cycle: [{ name: "src/alpha.ts" }, { name: "src/beta.ts" }],
        }],
      },
      {
        source: "src/gamma.ts",
        dependencies: [{
          circular: true,
          cycle: [{ name: "src/delta.ts" }, { name: "src/gamma.ts" }],
        }],
      },
    ],
  };
  const fileCycles = normalizeFileCycles(report);

  assert.deepEqual(fileCycles, [
    ["src/alpha.ts", "src/beta.ts"],
    ["src/delta.ts", "src/gamma.ts"],
  ]);
  assert.equal(hasFileCycles([]), false);
  assert.equal(hasFileCycles(fileCycles), true);
});

test("an unknown worker source path fails the boundary gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "boundary-unknown-gate-"));
  const source = join(root, "apps/worker/src/unknown-tier");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "x.ts"), "export const value = 1;\n");

  const result = gate("boundaries.mjs", ["--root", root]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /Unknown paths\napps\/worker\/src\/unknown-tier\/x\.ts/);
});

test("the boundary gate reads a fixture the same way at any path depth", () => {
  const base = mkdtempSync(join(tmpdir(), "boundary-depth-gate-")),
    deepRoot = boundaryFixture(join(base, "far/down/the/tree")),
    nearRoot = boundaryFixture(join(base, "near")),
    runDeep = gate("boundaries.mjs", ["--root", deepRoot]),
    runNear = gate("boundaries.mjs", ["--root", nearRoot]);
  assert.equal(runNear.status, gateFailure, runNear.stderr || runNear.stdout);
  assert.equal(runDeep.status, gateFailure, runDeep.stderr || runDeep.stdout);
  assert.match(runNear.stdout, /app->db\s+1/u);
  assert.equal(runNear.stdout, runDeep.stdout);
});

test("a missing gate tool names the tool instead of failing on its output", () => {
  const base = mkdtempSync(join(tmpdir(), "boundary-missing-tool-")),
    copied = standaloneGateRoot(base),
    outcome = gate("boundaries.mjs", [], copied);
  assert.equal(outcome.status, gateFailure, outcome.stdout);
  assert.match(outcome.stderr, /boundaries FAIL: depcruise is not installed/u);
});

test("an existing retired path fails the no-resurrected-paths gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "resurrected-gate-"));
  const list = join(root, "paths.json");
  await mkdir(join(root, "removed"));
  await writeFile(join(root, "removed/path.ts"), "export {};\n");
  await writeFile(list, '["removed/path.ts"]\n');

  const result = gate("no-resurrected-paths.mjs", ["--root", root, "--list", list]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /removed\/path\.ts/);
});

test("ignored retired residue is reported but passes the no-resurrected-paths gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "resurrected-ignored-gate-"));
  const list = join(root, "paths.json");
  await writeFile(join(root, ".gitignore"), "removed/\n");
  await mkdir(join(root, "removed"));
  await writeFile(join(root, "removed/path.ts"), "export {};\n");
  await writeFile(list, '["removed/path.ts"]\n');

  const initialized = spawnSync("/usr/bin/git", ["init", "-q"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(initialized.status, gateSuccess, initialized.stderr || initialized.stdout);

  const result = gate("no-resurrected-paths.mjs", ["--root", root, "--list", list]);
  assert.equal(result.status, gateSuccess, result.stderr || result.stdout);
  assert.match(result.stdout, /removed\/path\.ts\s+ignored residue/u);
  assert.match(result.stdout, /delete directory removed\/path\.ts/u);
  assert.match(result.stdout, /no-resurrected-paths PASS/u);
});

test("two awaited database writes outside repositories fail the consecutive-writes gate", () => {
  const root = makeDepsRoot("consecutive-writes-fail-", {
    "apps/worker/src/services/multi.ts": [
      "async function save() {",
      "  await db.insert(values);",
      "  await db.update(values);",
      "}",
      "",
    ].join("\n"),
  });
  const result = gate("consecutive-writes.mjs", ["--root", root]);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(result.stdout, /apps\/worker\/src\/services\/multi\.ts/);
  assert.match(result.stdout, /2 awaited db writes/);
});

test("repository and allowlisted writes pass the consecutive-writes gate", () => {
  const root = makeDepsRoot("consecutive-writes-allowed-", {
    "apps/worker/src/db/repositories/allowed.ts": [
      "async function save() {",
      "  await db.insert(values);",
      "  await db.update(values);",
      "}",
      "",
    ].join("\n"),
    "apps/worker/src/workflow-definition/template-seed.ts": [
      "async function seed() {",
      "  await db.insert(values);",
      "  await db.update(values);",
      "}",
      "",
    ].join("\n"),
  });
  const result = gate("consecutive-writes.mjs", ["--root", root]);
  assert.equal(result.status, gateSuccess, result.stderr || result.stdout);
  assert.match(result.stdout, /consecutive-writes PASS/);
});

test("typed functions and arrow function properties count awaited writes", () => {
  const root = makeDepsRoot("consecutive-writes-typed-", {
    "apps/worker/src/services/typed.ts": [
      "async function save(): Promise<void> {",
      "  await db.insert(values);",
      "  await db.update(values);",
      "}",
      "",
    ].join("\n"),
    "apps/worker/src/services/property.ts": [
      "const service = {",
      "  save: async (): Promise<void> => {",
      "    await getDb().delete(values);",
      "    await getDb().execute(values);",
      "  },",
      "};",
      "",
    ].join("\n"),
  });
  const result = gate("consecutive-writes.mjs", ["--root", root]);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(result.stdout, /apps\/worker\/src\/services\/typed\.ts/u);
  assert.match(result.stdout, /apps\/worker\/src\/services\/property\.ts/u);
  assert.match(result.stdout, /2 awaited db writes/u);
});

test("sibling functions, nested arrows, and select pairs are scoped independently", () => {
  const root = makeDepsRoot("consecutive-writes-scopes-", {
    "apps/worker/src/services/scopes.ts": [
      "async function first() {",
      "  await db.insert(values);",
      "}",
      "async function second() {",
      "  await db.update(values);",
      "}",
      "const service = {",
      "  save: async () => {",
      "    await db.delete(values);",
      "    const nested = async () => {",
      "      await db.execute(values);",
      "    };",
      "    await nested();",
      "  },",
      "};",
      "async function selects() {",
      "  await db.select(values);",
      "  await db.select(values);",
      "}",
      "",
    ].join("\n"),
  });
  const result = gate("consecutive-writes.mjs", ["--root", root]);
  assert.equal(result.status, gateSuccess, result.stderr || result.stdout);
  assert.match(result.stdout, /consecutive-writes PASS/u);
});

test("the db client fence counts import forms, ignores comments, and is a hard gate", async () => {
  const root = standaloneGateRoot(makeDepsRoot("db-client-fence-", {
    "apps/worker/src/db/client.ts": "export const db = 1;\n",
    "apps/worker/src/db/barrel.ts": 'export { db } from "./client.js";\n',
    "apps/worker/src/services/static.ts": 'import { db } from "../db/client.js"; void db;\n',
    "apps/worker/src/services/multiline.ts": 'import {\n  db,\n} from "../db/client.js";\nvoid db;\n',
    "apps/worker/src/services/side-effect.ts": 'import "../db/client.js";\n',
    "apps/worker/src/services/type.ts": 'import type { db } from "../db/client.js"; type T = typeof db;\n',
    "apps/worker/src/services/dynamic.ts": 'void import("../db/client.js");\n',
    "apps/worker/src/services/exported.ts": 'export { db } from "../db/client.js";\n',
    "apps/worker/src/services/mocked.ts": 'vi.mock("../db/client.js");\n',
    "apps/worker/src/services/barrel.ts": 'import { db } from "../db/barrel.js"; void db;\n',
    "apps/worker/src/services/comment.ts": '// import { db } from "../db/client.js";\nconst text = "db/client";\n',
    "apps/worker/src/services/ignored.test.ts": 'import { db } from "../db/client.js"; void db;\n',
  }));
  const fail = gate("db-client-fence.mjs", ["--root", root], root);
  assert.equal(fail.status, gateFailure, fail.stderr || fail.stdout);
  assert.match(fail.stdout, /services\/static\.ts/u);
  assert.match(fail.stdout, /services\/barrel\.ts/u);

  await Promise.all([
    "static.ts", "multiline.ts", "side-effect.ts", "type.ts", "dynamic.ts",
    "exported.ts", "mocked.ts", "barrel.ts",
  ].map((name) => rename(
    join(root, `apps/worker/src/services/${name}`),
    join(root, `apps/worker/src/services/${name}.test.ts`),
  )));
  await rename(
    join(root, "apps/worker/src/routes/entry.ts"),
    join(root, "apps/worker/src/routes/entry.test.ts"),
  );
  const pass = gate("db-client-fence.mjs", ["--root", root], root);
  assert.equal(pass.status, gateSuccess, pass.stderr || pass.stdout);
  assert.match(pass.stdout, /production db\/client reachability\s+0/u);
});

test("a reintroduced definition schema branch fails the single schema version gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "single-schema-gate-"));
  const source = join(root, "apps/worker/src/workflow-definition");
  const examples = join(root, "docs/example-workflows");
  await mkdir(source, { recursive: true });
  await mkdir(examples, { recursive: true });

  const spellings = [
    "export const less = (schemaVersion: number) => schemaVersion < 2;",
    "export const lessOrEqual = (schemaVersion: number) => schemaVersion <= \"2\";",
    "export const greater = (schemaVersion: number) => schemaVersion > 1;",
    "export const greaterOrEqual = (schemaVersion: number) => schemaVersion >= '1';",
    "export const equal = (schemaVersion: number) => schemaVersion == 1;",
    "export const notEqual = (schemaVersion: number) => schemaVersion != \"2\";",
    "export const strictEqual = (schemaVersion: number) => schemaVersion === 1;",
    "export const strictNotEqual = (schemaVersion: number) => schemaVersion !== '2';",
    'export const objectLiteral = { "schemaVersion": 1 };',
    "export type schemaType = { schemaVersion: 1 };",
    "export const legacy = isLegacy;",
    "export type legacyDefinition = WorkflowDefinitionV1;",
    "export const v2Only = isV2OnlyBlockType;",
    "export const oldWalker = executeGraph;",
  ].join("\n") + "\n";
  await writeFile(join(source, "planner.ts"), spellings);
  await writeFile(join(source, "planner.test.ts"), spellings);
  await writeFile(
    join(source, "stored-definition.ts"),
    "export const retired = (definition: { schemaVersion: number }) => definition.schemaVersion === 1;\nexport const reason = RETIRED_SCHEMA_MESSAGE;\n",
  );
  await writeFile(join(examples, "legacy.json"), '{ "schemaVersion": 1 }\n');

  const manifest = join(root, "apps/worker/src/harness-profiles");
  await mkdir(manifest, { recursive: true });
  await writeFile(
    join(manifest, "manifest.ts"),
    "export const oldManifest = (schemaVersion: number) => schemaVersion === 1;\n",
  );

  const result = gate("single-schema-version.mjs", ["--root", root]);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  for (const match of [
    "schemaVersion < 2",
    'schemaVersion <= "2"',
    "schemaVersion > 1",
    "schemaVersion >= '1'",
    "schemaVersion == 1",
    'schemaVersion != "2"',
    "schemaVersion === 1",
    "schemaVersion !== '2'",
    '"schemaVersion": 1',
    "schemaVersion: 1",
    "isLegacy",
    "WorkflowDefinitionV1",
    "isV2OnlyBlockType",
    "executeGraph",
  ]) {
    assert.ok(result.stdout.includes(match), `missing gate match: ${match}`);
  }
  assert.match(result.stdout, /apps\/worker\/src\/workflow-definition\/planner\.ts/u);
  assert.match(result.stdout, /docs\/example-workflows\/legacy\.json/u);
  assert.doesNotMatch(result.stdout, /planner\.test\.ts/u);
  assert.doesNotMatch(result.stdout, /stored-definition\.ts/u);
  assert.doesNotMatch(result.stdout, /harness-profiles\/manifest\.ts/u);
});

test("adversarial retired schema spellings each fail the single schema version gate", () => {
  const fixtures = [
    {
      file: "apps/worker/src/definition.ts",
      contents: 'export const old = definition["schemaVersion"] === 1;\n',
      match: /\["schemaVersion"\]/u,
    },
    {
      file: "apps/worker/src/definition.ts",
      contents: 'export const old = definition?.["schemaVersion"] === 1;\n',
      match: /\?\.\["schemaVersion"\]/u,
    },
    {
      file: "apps/worker/src/definition.ts",
      contents: "export const old = def['schemaVersion'] === 1;\n",
      match: /\['schemaVersion'\]/u,
    },
    {
      file: "apps/worker/src/definition.ts",
      contents: "const revision = definition.schemaVersion; export const old = revision === 1;\n",
      match: /revision === 1/u,
    },
    {
      file: "docs/example-workflows/legacy.json",
      contents: '{ "schemaVersion": 1e0 }\n',
      match: /schemaVersion: 1/u,
    },
    {
      file: "apps/worker/src/definition.ts",
      contents: "export interface WorkflowDefinitionV1 { nodes: unknown[] }\n",
      match: /WorkflowDefinitionV1/u,
    },
    {
      file: "apps/worker/src/definition.ts",
      contents: [
        "const {",
        "  schemaVersion: retiredVersion,",
        "} = definition;",
        "export const old = retiredVersion === 1;",
        "",
      ].join("\n"),
      match: /retiredVersion === 1/u,
    },
    {
      file: "apps/worker/src/definition.ts",
      contents: [
        'const { ["schemaVersion"]: alias } = def;',
        "export const old = alias === 1;",
        "",
      ].join("\n"),
      match: /alias === 1/u,
    },
    {
      file: "apps/worker/src/definition.ts",
      contents: "export const versions = [{ schemaVersion: 2 }, { schemaVersion: 1 }];\n",
      match: /schemaVersion: 1/u,
    },
    {
      file: "apps/worker/src/definition.ts",
      contents: "export const old = workflowDefinitionSchemaVersionOf(definition) === 1;\n",
      match: /workflowDefinitionSchemaVersionOf\(definition\) === 1/u,
    },
    {
      file: "apps/worker/src/definition.ts",
      contents: "export const old = SchemaVersionOf(definition) === 0x1;\n",
      match: /SchemaVersionOf\(definition\) === 0x1/u,
    },
    {
      file: "apps/worker/src/harness-profiles/manifest.ts",
      contents: [
        'import { workflowDefinitionSchemaVersionOf } from "../../../../packages/contracts/domain";',
        "export const old = workflowDefinitionSchemaVersionOf(definition) === 1;",
        "",
      ].join("\n"),
      match: /workflowDefinitionSchemaVersionOf\(definition\) === 1/u,
    },
    {
      file: "apps/worker/src/runtime.ts",
      contents: 'import { executeLegacy } from "./legacy-runtime.test";\nexport { executeLegacy };\n',
      match: /production imports test module \.\/legacy-runtime\.test/u,
    },
    {
      file: "apps/worker/src/workflow-definition/stored-definition.ts",
      contents: "export type Runtime = WorkflowDefinitionV1;\n",
      match: /WorkflowDefinitionV1/u,
    },
    {
      file: "apps/worker/src/workflow-definition/stored-definition.ts",
      contents: "export const runtime = executeRetiredDefinition;\n",
      match: /executeRetiredDefinition/u,
    },
  ];

  for (const [index, fixture] of fixtures.entries()) {
    const root = makeDepsRoot(`single-schema-adversarial-${index}-`, {
      [fixture.file]: fixture.contents,
    });
    const result = gate("single-schema-version.mjs", ["--root", root]);
    assert.equal(result.status, gateFailure, result.stderr || result.stdout);
    assert.match(result.stdout, fixture.match);
  }
});

test("an unrelated harness profile schema version branch passes the single schema version gate", () => {
  const root = makeDepsRoot("single-schema-harness-pass-", {
    "apps/worker/src/harness-profiles/manifest.ts":
      "export const oldManifest = (schemaVersion: number) => schemaVersion === 1;\n",
  });
  const result = gate("single-schema-version.mjs", ["--root", root]);
  assert.equal(result.status, gateSuccess, result.stderr || result.stdout);
  assert.match(result.stdout, /single-schema-version PASS/u);
});

test("a harness profile importing a local re-export is scanned for retired version helpers", () => {
  const root = makeDepsRoot("single-schema-harness-local-import-", {
    "apps/worker/src/harness-profiles/manifest.ts": [
      'import { readRevision } from "./manifest-version";',
      "export const retired = readRevision(definition) === 1;",
      "",
    ].join("\n"),
    "apps/worker/src/harness-profiles/manifest-version.ts": [
      'export { workflowDefinitionSchemaVersionOf as readRevision } from "@shared/contracts";',
      "",
    ].join("\n"),
  });
  const result = gate("single-schema-version.mjs", ["--root", root]);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(result.stdout, /readRevision\(definition\) === 1/u);
});

test("a workspace package without a description fails package contracts", async () => {
  const root = await mkdtemp(join(tmpdir(), "package-contracts-gate-"));
  const directory = join(root, "packages/conditions");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), '{"name":"@shared/conditions"}\n');

  const result = gate("package-contracts.mjs", ["--root", root]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /packages\/conditions\/package\.json/);
});

test("a shared dependency off the catalog fails deps consistency", () => {
  const result = gate("check-deps-consistency.mjs", ["--root", makeDepsRoot("deps-consistency-gate-", {
    "apps/one/package.json": '{"name":"one","dependencies":{"zod":"^3.25.76"}}\n',
    "apps/two/package.json": '{"name":"two","dependencies":{"zod":"^3.25.76"}}\n',
    "package.json": '{"name":"root"}\n',
    "pnpm-workspace.yaml": 'packages:\n  - "apps/*"\n',
  })]);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(result.stdout, /zod\s+2\s+\^3\.25\.76\s+not-cataloged/u);
});

test("two specifiers for one shared dependency fail deps consistency", () => {
  const result = gate("check-deps-consistency.mjs", ["--root", makeDepsRoot("deps-split-gate-", {
    "apps/one/package.json": '{"name":"one","devDependencies":{"typescript":"catalog:"}}\n',
    "apps/two/package.json": '{"name":"two","devDependencies":{"typescript":"^5.6.0"}}\n',
    "package.json": '{"name":"root"}\n',
    "pnpm-workspace.yaml": 'packages:\n  - "apps/*"\n\ncatalog:\n  typescript: ^5.8\n',
  })]);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(result.stdout, /typescript\s+2\s+catalog: \| \^5\.6\.0\s+split/u);
});

test("a shared peer or optional dependency fails deps consistency", () => {
  const result = gate("check-deps-consistency.mjs", ["--root", makeDepsRoot("deps-peer-gate-", {
    "apps/one/package.json": '{"name":"one","peerDependencies":{"yaml":"^2.9.0"}}\n',
    "apps/two/package.json": '{"name":"two","optionalDependencies":{"yaml":"^2.9.0"}}\n',
    "package.json": '{"name":"root"}\n',
    "pnpm-workspace.yaml": 'packages:\n  - "apps/*"\n',
  })]);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(result.stdout, /yaml\s+2\s+\^2\.9\.0\s+not-cataloged/u);
});

test("a catalogued shared dependency passes deps consistency", () => {
  const result = gate("check-deps-consistency.mjs", ["--root", makeDepsRoot("deps-ok-gate-", {
    "apps/one/package.json": '{"name":"one","dependencies":{"zod":"catalog:","only-here":"^1.0.0"}}\n',
    "apps/two/package.json": '{"name":"two","dependencies":{"zod":"catalog:","@shared/one":"workspace:*"}}\n',
    "package.json": '{"name":"root"}\n',
    "pnpm-workspace.yaml": 'packages:\n  - "apps/*"\n\ncatalog:\n  zod: ^3.25.76\n',
  })]);
  assert.equal(result.status, gateSuccess, result.stderr || result.stdout);
  assert.match(result.stdout, /check-deps-consistency PASS/u);
});

test("lint and unused-code gates are unconditional", () => {
  const lint = gate("lint.mjs");
  assert.equal(lint.status, gateSuccess, lint.stderr || lint.stdout);
  assert.match(lint.stdout, /lint PASS/u);

  const unused = gate("unused-code.mjs");
  assert.equal(unused.status, gateSuccess, unused.stderr || unused.stdout);
  assert.match(unused.stdout, /unused-code PASS/u);
});

test("retired gate baselines and update commands are absent", async () => {
  assert.deepEqual(
    readdirSync(join(repoRoot, "scripts/gates"))
      .filter((file) => file.endsWith(".baseline.json")),
    [],
  );
  const rootPackage = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  assert.equal(rootPackage.scripts["gates:update-baselines"], undefined);
  for (const file of readdirSync(join(repoRoot, "scripts/gates"))) {
    if (!file.endsWith(".mjs")) continue;
    const source = readFileSync(join(repoRoot, "scripts/gates", file), "utf8");
    assert.doesNotMatch(source, /--update-baseline|--baseline|countRegression|writeJson/u, file);
  }
});

test("the composite gate ladder includes both database fences", async () => {
  const rootPackage = JSON.parse(
    await readFile(join(repoRoot, "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  assert.match(rootPackage.scripts.gates, /gate:transactions/u);
  assert.match(rootPackage.scripts.gates, /gate:consecutive-writes/u);
  assert.match(rootPackage.scripts.gates, /gate:db-client-fence/u);
  assert.equal(rootPackage.scripts["gate:docs-status"], "node scripts/gates/docs-status.mjs");
  assert.doesNotMatch(rootPackage.scripts["gate:docs-status"], /if \[ -f/u);
  assert.equal(rootPackage.scripts["gates:update-baselines"], undefined);
});

// Two service clusters, where beta reaches past alpha's interface.
const clusterFixture = async (deep: boolean): Promise<{ root: string; deepImports: string }> => {
  const root = await mkdtemp(join(tmpdir(), "cluster-gate-"));
  const services = join(root, "apps/worker/src/services");
  await mkdir(join(services, "alpha"), { recursive: true });
  await mkdir(join(services, "beta"), { recursive: true });
  await writeFile(join(services, "alpha/thing.ts"), "export const thing = 1;\n");
  await writeFile(join(services, "alpha/index.ts"), 'export { thing } from "./thing.js";\n');
  await writeFile(
    join(services, "beta/user.ts"),
    `import { thing } from "../alpha/${deep ? "thing" : "index"}.js";\nexport const used = thing;\n`,
  );
  await writeFile(join(services, "beta/index.ts"), 'export { used } from "./user.js";\n');
  const deepImports = join(root, "cluster-deep-imports.json");
  await writeFile(deepImports, "[]\n");
  return { root, deepImports };
};

test("a services cluster file classifies as services and its test as testing", () => {
  const root = repoRoot;
  assert.equal(classify(root, "apps/worker/src/services/dispatch/dispatch.ts"), "services");
  assert.equal(classify(root, "apps/worker/src/services/dispatch/index.ts"), "services");
  assert.equal(classify(root, "apps/worker/src/services/dispatch/dispatch.test.ts"), "testing");
});

test("the cross-cluster rule names deep imports and accepts the interface", () => {
  assert.equal(
    crossClusterDeepImport(
      "apps/worker/src/services/beta/user.ts",
      "apps/worker/src/services/alpha/thing.ts",
    ),
    true,
  );
  assert.equal(
    crossClusterDeepImport(
      "apps/worker/src/services/beta/user.ts",
      "apps/worker/src/services/alpha/index.ts",
    ),
    false,
  );
  assert.equal(
    crossClusterDeepImport(
      "apps/worker/src/services/beta/user.ts",
      "apps/worker/src/services/beta/other.ts",
    ),
    false,
  );
  const drift = deepImportRegression([["a", "b"]], [["c", "d"]]);
  assert.deepEqual(drift.added, [["a", "b"]]);
  assert.deepEqual(drift.stale, [["c", "d"]]);
});

test("an unlisted cross-cluster deep import fails the boundary gate", async () => {
  const deepCase = await clusterFixture(true);
  const failing = gate("boundaries.mjs", [
    "--root", deepCase.root,
    "--cluster-deep-imports", deepCase.deepImports,
  ]);
  assert.equal(failing.status, gateFailure, failing.stderr || failing.stdout);
  assert.match(
    failing.stdout,
    /new deep import {2}apps\/worker\/src\/services\/beta\/user\.ts -> apps\/worker\/src\/services\/alpha\/thing\.ts/u,
  );

  const interfaceCase = await clusterFixture(false);
  const passing = gate("boundaries.mjs", [
    "--root", interfaceCase.root,
    "--cluster-deep-imports", interfaceCase.deepImports,
  ]);
  assert.equal(passing.status, gateSuccess, passing.stderr || passing.stdout);
});
