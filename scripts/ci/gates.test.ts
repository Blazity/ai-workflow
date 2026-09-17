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
  // The gate refuses a source root it cannot find, so a fixture declares all
  // three and puts its source in whichever one the case is about.
  singleSchemaRoot = (prefix: string, files: Record<string, string> = {}): string => {
    const root = makeDepsRoot(prefix, files);
    for (const anchor of ["apps", "packages", "docs/example-workflows"]) {
      mkdirSync(join(root, anchor), { recursive: true });
    }
    return root;
  },
  // consecutive-writes derives its coverage from apps/ and packages/, so every
  // fixture carries both parents whether or not the case puts code in them.
  writesRoot = (prefix: string, files: Record<string, string>): string => {
    const root = makeDepsRoot(prefix, files);
    mkdirSync(join(root, "apps"), { recursive: true });
    mkdirSync(join(root, "packages"), { recursive: true });
    return root;
  },
  // The fence compares against the worker's client and schema and derives its
  // coverage from apps/ and packages/, so every fixture carries those anchors.
  fenceRoot = (prefix: string, files: Record<string, string>): string => {
    const root = makeDepsRoot(prefix, {
      "apps/worker/src/db/client.ts": "export const db = 1;\n",
      "apps/worker/src/db/schema.ts": "export const harnessTable = 1;\n",
      ...files,
    });
    mkdirSync(join(root, "packages"), { recursive: true });
    return root;
  },
  // A workspace holding a copy of the gates, for the gates that resolve their
  // own root from process.cwd() or from where the script itself sits.
  copiedGateRoot = (prefix: string, files: Record<string, string> = {}): string => {
    const root = makeDepsRoot(prefix, files);
    cpSync(join(repoRoot, "scripts/gates"), join(root, "scripts/gates"), { recursive: true });
    return root;
  },
  standaloneGateRoot = (root: string): string => {
    cpSync(join(repoRoot, "scripts/gates"), join(root, "scripts/gates"), { recursive: true });
    // The boundary gate refuses a missing dependency-cruiser config before it
    // looks for the tool, so the fixture carries one to keep the tool the
    // subject of the test.
    writeFileSync(join(root, ".dependency-cruiser.cjs"), "module.exports = { forbidden: [] };\n");
    return boundaryFixture(root);
  };

function gate(name: string, args: string[] = [], root: string = repoRoot) {
  return spawnSync(process.execPath, [join(root, "scripts/gates", name), ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

// A draft carries no currency and no reachability claim, so a seeded anchor
// adds a document to the checked set without adding a failure of its own.
const seededAnchor = "Status: draft\nLast-verified: 2026-09-01\n\n# Seeded anchor\n";

function docsStatusFixture(files: Record<string, string>): string {
  const anchors: Record<string, string> = {};
  for (const path of [
    "README.md",
    "AGENTS.md",
    "SETUP.md",
    "CONTEXT.md",
    "packages/AGENTS.md",
    "docs/index.md",
  ]) {
    if (!(path in files)) anchors[path] = seededAnchor;
  }
  const root = makeDepsRoot("docs-status-fixture-", { ...anchors, ...files });
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

test("docs-status refuses when the paths its checked set is built from are gone", () => {
  const root = docsStatusFixture({ "README.md": seededAnchor });
  spawnSync("/bin/rm", ["-rf", join(root, "docs"), join(root, "CONTEXT.md")]);
  const result = gate("docs-status.mjs", [], root);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(
    result.stderr,
    /docs-status: the set of checked documents is computed from paths that are missing: CONTEXT\.md, docs\./u,
  );
});

test("docs-status refuses an empty docs tree", () => {
  const root = docsStatusFixture({});
  spawnSync("/bin/rm", ["-f", join(root, "docs/index.md")]);
  const result = gate("docs-status.mjs", [], root);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(result.stderr, /docs-status: 0 Markdown documents were found under docs\//u);
});

test("docs-status counts what it read on the way past", () => {
  const result = gate("docs-status.mjs", [], docsStatusFixture({}));
  assert.equal(result.status, gateSuccess, result.stderr || result.stdout);
  assert.match(result.stdout, /docs-status: 6 document\(s\) checked, 0 skipped for frontmatter/u);
});

test("the transactions gate refuses a workspace parent that is not there", () => {
  const root = copiedGateRoot("transactions-missing-parent-");
  mkdirSync(join(root, "apps/worker/src"), { recursive: true });
  const result = gate("transactions-in-repositories.mjs", [], root);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(
    result.stderr,
    /transactions-in-repositories FAIL: a workspace parent this gate derives its roots from is missing at packages/u,
  );
});

test("the transactions gate refuses a workspace with no project in it", () => {
  const root = copiedGateRoot("transactions-no-projects-");
  mkdirSync(join(root, "apps"), { recursive: true });
  mkdirSync(join(root, "packages"), { recursive: true });
  const result = gate("transactions-in-repositories.mjs", [], root);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(
    result.stderr,
    /transactions-in-repositories FAIL: 0 workspace projects were found under apps, packages/u,
  );
});

test("the transactions gate refuses a project holding no source", () => {
  const root = copiedGateRoot("transactions-empty-project-");
  mkdirSync(join(root, "apps/worker/src"), { recursive: true });
  mkdirSync(join(root, "packages"), { recursive: true });
  const result = gate("transactions-in-repositories.mjs", [], root);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(
    result.stderr,
    /transactions-in-repositories FAIL: 0 source files were found under apps, packages/u,
  );
});

test("the transactions gate scans workspace packages, not only the worker", () => {
  const root = copiedGateRoot("transactions-packages-", {
    "apps/worker/src/index.ts": "export const value = 1;\n",
    "packages/conditions/evaluate.ts":
      "export const run = async (db) => db.transaction(async () => undefined);\n",
  });
  const result = gate("transactions-in-repositories.mjs", [], root);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(result.stdout, /packages\/conditions\/evaluate\.ts:1/u);
  assert.match(result.stdout, /transactions-in-repositories FAIL/u);
});

test("the db client fence scans the dashboard, not only the worker", () => {
  const result = gate("db-client-fence.mjs", ["--root", fenceRoot("db-client-fence-dashboard-", {
    "apps/dashboard/app/page.tsx": 'import { sql } from "drizzle-orm";\nexport const query = sql;\n',
  })]);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(result.stdout, /apps\/dashboard\/app\/page\.tsx/u);
});

test("the db client fence scans a workspace package", () => {
  const result = gate("db-client-fence.mjs", ["--root", fenceRoot("db-client-fence-package-", {
    "packages/conditions/read.ts": 'import { sql } from "drizzle-orm";\nexport const query = sql;\n',
  })]);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(result.stdout, /packages\/conditions\/read\.ts/u);
});

test("the db client fence resolves the dashboard's own alias, not the worker's", () => {
  const result = gate("db-client-fence.mjs", ["--root", fenceRoot("db-client-fence-alias-", {
    "apps/dashboard/lib/database.ts": 'export { sql } from "drizzle-orm";\n',
    "apps/dashboard/app/page.tsx": 'import { sql } from "@/lib/database";\nexport const query = sql;\n',
  })]);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(result.stdout, /apps\/dashboard\/app\/page\.tsx/u);
});

test("the db client fence leaves the excluded worker scripts alone", () => {
  const result = gate("db-client-fence.mjs", ["--root", fenceRoot("db-client-fence-excluded-", {
    "apps/worker/scripts/db-migrate.ts": 'import { drizzle } from "drizzle-orm/neon-http";\nexport const run = drizzle;\n',
    "apps/worker/src/services/clean.ts": "export const value = 1;\n",
  })]);
  assert.equal(result.status, gateSuccess, result.stderr || result.stdout);
  assert.match(result.stdout, /db-client-fence PASS/u);
});

test("the db client fence refuses when the client it compares against has moved", () => {
  const root = makeDepsRoot("db-client-fence-renamed-", {
    "apps/worker/src/db/pool.ts": "export const db = 1;\n",
    "apps/worker/src/db/schema.ts": "export const harnessTable = 1;\n",
    "apps/worker/src/services/reader.ts": 'import { db } from "../db/pool.js"; void db;\n',
  });
  const result = gate("db-client-fence.mjs", ["--root", root]);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(
    result.stderr,
    /db-client-fence FAIL: the database client module the fence compares against is missing at apps\/worker\/src\/db\/client\.ts/u,
  );
});

test("the db client fence refuses when the schema it compares against has moved", () => {
  const root = makeDepsRoot("db-client-fence-schemaless-", {
    "apps/worker/src/db/client.ts": "export const db = 1;\n",
    "apps/worker/src/services/reader.ts": "export const value = 1;\n",
  });
  const result = gate("db-client-fence.mjs", ["--root", root]);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(
    result.stderr,
    /db-client-fence FAIL: the database schema module the fence compares against is missing at both apps\/worker\/src\/db\/schema\.ts and apps\/worker\/src\/db\/schema/u,
  );
});

test("the ui primitives gate refuses dashboard roots that are not there", () => {
  const result = gate("ui-primitives.mjs", ["--root", makeDepsRoot("ui-primitives-missing-root-", {})]);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(
    result.stderr,
    /ui-primitives FAIL: a dashboard source root this gate scans is missing at apps\/dashboard\/components/u,
  );
});

test("the single schema version gate refuses a source root that is not there", () => {
  const result = gate("single-schema-version.mjs", ["--root", makeDepsRoot("single-schema-missing-root-", {
    "apps/worker/src/definition.ts": "export const value = 2;\n",
  })]);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(
    result.stderr,
    /single-schema-version FAIL: a source root this gate scans is missing at packages/u,
  );
});

test("the consecutive-writes gate refuses a workspace parent that is not there", () => {
  const result = gate("consecutive-writes.mjs", ["--root", makeDepsRoot("consecutive-writes-missing-parent-", {
    "apps/worker/src/index.ts": "export const value = 1;\n",
  })]);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(
    result.stderr,
    /consecutive-writes FAIL: a workspace parent this gate derives its roots from is missing at packages/u,
  );
});

test("the consecutive-writes gate refuses a workspace with no project in it", () => {
  const root = writesRoot("consecutive-writes-no-projects-", {});
  const result = gate("consecutive-writes.mjs", ["--root", root]);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(
    result.stderr,
    /consecutive-writes FAIL: 0 workspace projects were found under apps, packages/u,
  );
});

test("the consecutive-writes gate refuses a project holding no source", () => {
  const root = writesRoot("consecutive-writes-empty-project-", {});
  mkdirSync(join(root, "apps/worker/src"), { recursive: true });
  const result = gate("consecutive-writes.mjs", ["--root", root]);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(
    result.stderr,
    /consecutive-writes FAIL: 0 source files were found under apps, packages/u,
  );
});

const pairOfWrites = "async function save() {\n  await db.insert(values);\n  await db.update(values);\n}\n";

test("the consecutive-writes gate scans workspace packages, not only the worker", () => {
  const result = gate("consecutive-writes.mjs", ["--root", writesRoot("consecutive-writes-package-", {
    "apps/worker/src/index.ts": "export const value = 1;\n",
    "packages/shared/save.ts": pairOfWrites,
  })]);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(result.stdout, /packages\/shared\/save\.ts:2 \(2 awaited db writes\)/u);
});

test("the consecutive-writes gate scans worker tooling outside src", () => {
  const result = gate("consecutive-writes.mjs", ["--root", writesRoot("consecutive-writes-tooling-", {
    "apps/worker/src/index.ts": "export const value = 1;\n",
    "apps/worker/scripts/clean.ts": pairOfWrites,
  })]);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(result.stdout, /apps\/worker\/scripts\/clean\.ts:2 \(2 awaited db writes\)/u);
});

test("package contracts refuses a packages directory that is not there", () => {
  const result = gate("package-contracts.mjs", ["--root", makeDepsRoot("package-contracts-missing-root-", {})]);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(
    result.stderr,
    /package-contracts FAIL: a package root this gate scans is missing at packages/u,
  );
});

test("package contracts refuses a packages directory holding no manifest", () => {
  const root = makeDepsRoot("package-contracts-empty-root-", {});
  mkdirSync(join(root, "packages"), { recursive: true });
  const result = gate("package-contracts.mjs", ["--root", root]);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(
    result.stderr,
    /package-contracts FAIL: 0 workspace package manifests were found under packages/u,
  );
});

test("the model catalog gate refuses a source root that is not there", () => {
  const result = gate("model-catalog-drift.mjs", ["--root", makeDepsRoot("model-catalog-missing-root-", {
    "apps/worker/src/thing.ts": "export const value = 1;\n",
  })]);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(
    result.stderr,
    /model-catalog-drift FAIL: a source root this gate scans is missing at packages/u,
  );
});

test("deps consistency refuses a workspace glob that matches no project", () => {
  const result = gate("check-deps-consistency.mjs", ["--root", makeDepsRoot("deps-empty-glob-gate-", {
    "apps/one/package.json": '{"name":"one","dependencies":{"zod":"^3.25.76"}}\n',
    "apps/two/package.json": '{"name":"two","dependencies":{"zod":"^3.25.76"}}\n',
    "package.json": '{"name":"root"}\n',
    "pnpm-workspace.yaml": 'packages:\n  - "renamed-apps/*"\n',
  })]);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(
    result.stderr,
    /check-deps-consistency FAIL: the pnpm-workspace\.yaml glob "renamed-apps\/\*" matches no workspace project/u,
  );
});

test("deps consistency refuses a workspace with nothing to compare", () => {
  const result = gate("check-deps-consistency.mjs", ["--root", makeDepsRoot("deps-single-project-gate-", {
    "package.json": '{"name":"root","dependencies":{"zod":"^3.25.76"}}\n',
    "pnpm-workspace.yaml": "packages: []\n",
  })]);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(
    result.stderr,
    /check-deps-consistency FAIL: the pnpm-workspace\.yaml globs resolve to 1 workspace project\(s\)/u,
  );
});

test("the lint gate refuses a shared root that is not there", () => {
  const root = copiedGateRoot("lint-missing-shared-root-");
  writeFileSync(join(root, ".oxlintrc.json"), "{}\n");
  mkdirSync(join(root, "apps/worker"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  const result = gate("lint.mjs", [], root);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(
    result.stderr,
    /lint FAIL: a shared lint root this gate declares is missing at packages/u,
  );
});

test("the lint gate refuses a missing apps directory", () => {
  const root = copiedGateRoot("lint-missing-apps-");
  writeFileSync(join(root, ".oxlintrc.json"), "{}\n");
  const result = gate("lint.mjs", [], root);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(
    result.stderr,
    /lint FAIL: the directory this gate derives its app roots from is missing at apps/u,
  );
});

test("the lint gate refuses an apps directory with no app in it", () => {
  const root = copiedGateRoot("lint-no-apps-");
  writeFileSync(join(root, ".oxlintrc.json"), "{}\n");
  mkdirSync(join(root, "apps"), { recursive: true });
  const result = gate("lint.mjs", [], root);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(result.stderr, /lint FAIL: 0 app directories were found under apps/u);
});

test("the lint gate lints an app nobody named", () => {
  const root = makeDepsRoot("lint-new-app-", {
    "apps/newapp/dirty.ts": "export const last = (items: string[]) => items[items.length - 1];\n",
  });
  for (const directory of ["apps/worker", "scripts", "packages"]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  const result = gate("lint.mjs", ["--root", root, "--config", join(repoRoot, ".oxlintrc.json")]);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(result.stdout, /apps\/newapp\/dirty\.ts:1:\d+ unicorn\(prefer-at\)/u);
});

test("the boundary gate refuses a dependency-cruiser config that is not there", () => {
  const root = makeDepsRoot("boundary-missing-config-", {});
  const result = gate("boundaries.mjs", ["--root", root, "--config", join(root, "absent.cjs")]);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(
    result.stderr,
    /boundaries FAIL: the dependency-cruiser configuration this gate reads is missing at .*absent\.cjs/u,
  );
});

test("the boundary gate refuses a dependency-cruiser report with no modules", () => {
  const root = makeDepsRoot("boundary-empty-report-", {
    "apps/worker/src/only.test.ts": "export const value = 1;\n",
  });
  const result = gate("boundaries.mjs", ["--root", root]);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(
    result.stderr,
    /boundaries FAIL: 0 modules were found under the dependency-cruiser report for apps\/worker\/src/u,
  );
});

test("the unused-code gate refuses a configured workspace that is not there", () => {
  const root = makeDepsRoot("unused-missing-workspace-", {
    "knip.json": '{"workspaces":{"apps/worker":{"entry":["src/index.ts"]}}}\n',
  });
  const result = gate("unused-code.mjs", ["--root", root, "--config", join(root, "knip.json")]);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(
    result.stderr,
    /unused-code FAIL: the Knip workspace "apps\/worker" is missing/u,
  );
});

test("the unused-code gate refuses a configured workspace glob that matches nothing", () => {
  const root = makeDepsRoot("unused-empty-glob-", {
    "knip.json": '{"workspaces":{"packages/*":{"entry":["index.ts"]}}}\n',
  });
  const result = gate("unused-code.mjs", ["--root", root, "--config", join(root, "knip.json")]);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(
    result.stderr,
    /unused-code FAIL: the Knip workspace glob "packages\/\*" matches no directory/u,
  );
});

test("the no-resurrected-paths gate refuses a retired path list that is not there", () => {
  const root = makeDepsRoot("resurrected-missing-list-", {});
  const result = gate("no-resurrected-paths.mjs", ["--root", root, "--list", join(root, "absent.json")]);
  assert.equal(result.status, gateFailure, result.stderr || result.stdout);
  assert.match(
    result.stderr,
    /no-resurrected-paths FAIL: the retired path list this gate reads is missing at .*absent\.json/u,
  );
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
  const root = writesRoot("consecutive-writes-fail-", {
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
  const root = writesRoot("consecutive-writes-allowed-", {
    "apps/worker/src/db/repositories/allowed.ts": [
      "async function save() {",
      "  await db.insert(values);",
      "  await db.update(values);",
      "}",
      "",
    ].join("\n"),
    "apps/worker/src/services/workflow-definitions/template-seed.ts": [
      "async function seed() {",
      "  await db.insert(values);",
      "  await db.update(values);",
      "}",
      "",
    ].join("\n"),
  });
  const allowlist = join(root, "allowlist.json");
  writeFileSync(allowlist, '["apps/worker/src/services/workflow-definitions/template-seed.ts"]\n');
  const result = gate("consecutive-writes.mjs", ["--root", root, "--allowlist", allowlist]);
  assert.equal(result.status, gateSuccess, result.stderr || result.stdout);
  assert.match(result.stdout, /consecutive-writes PASS/);
});

test("typed functions and arrow function properties count awaited writes", () => {
  const root = writesRoot("consecutive-writes-typed-", {
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
  const root = writesRoot("consecutive-writes-scopes-", {
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

test("the db client fence rejects raw database imports and allows new type only imports", async () => {
  const root = standaloneGateRoot(makeDepsRoot("db-client-fence-", {
    "apps/worker/src/db/client.ts": "export const db = 1;\n",
    "apps/worker/src/db/barrel.ts": 'export { db } from "./client.js";\n',
    "apps/worker/src/db/schema.ts": 'export { harnessTable } from "./schema/harness.js";\nexport type { HarnessTable } from "./schema/harness.js";\n',
    "apps/worker/src/db/schema/harness.ts": "export const harnessTable = 1;\nexport type HarnessTable = number;\n",
    "apps/worker/src/db/schema-barrel.ts": 'export { harnessTable } from "./schema/harness.js";\n',
    "apps/worker/src/db/schema-type-barrel.ts": 'export { type HarnessTable } from "./schema.js";\n',
    "apps/worker/src/services/static.ts": 'import { db } from "../db/client.js"; void db;\n',
    "apps/worker/src/services/multiline.ts": 'import {\n  db,\n} from "../db/client.js";\nvoid db;\n',
    "apps/worker/src/services/side-effect.ts": 'import "../db/client.js";\n',
    "apps/worker/src/services/type.ts": 'import type { db } from "../db/client.js"; type T = typeof db;\n',
    "apps/worker/src/services/dynamic.ts": 'void import("../db/client.js");\n',
    "apps/worker/src/services/exported.ts": 'export { db } from "../db/client.js";\n',
    "apps/worker/src/services/mocked.ts": 'vi.mock("../db/client.js");\n',
    "apps/worker/src/services/barrel.ts": 'import { db } from "../db/barrel.js"; void db;\n',
    "apps/worker/src/services/drizzle.ts": 'import { sql } from "drizzle-orm"; void sql;\n',
    "apps/worker/src/services/drizzle-subpath.ts": 'import { pgTable } from "drizzle-orm/pg-core"; void pgTable;\n',
    "apps/worker/src/services/drizzle-mixed.ts": 'import { type SQL, sql } from "drizzle-orm"; void sql;\ntype Query = SQL;\n',
    "apps/worker/src/services/schema.ts": 'import { harnessTable } from "../db/schema.js"; void harnessTable;\n',
    "apps/worker/src/services/schema-barrel.ts": 'import { harnessTable } from "../db/schema-barrel.js"; void harnessTable;\n',
    "apps/worker/src/services/allowed-types.ts": 'import type { SQL } from "drizzle-orm";\nimport type { HarnessTable } from "../db/schema.js";\ntype Pair = [SQL, HarnessTable];\n',
    "apps/worker/src/services/allowed-inline-types.ts": 'import { type SQL } from "drizzle-orm";\ntype Query = SQL;\n',
    "apps/worker/src/services/allowed-inline-reexport.ts": 'export { type HarnessTable } from "../db/schema-type-barrel.js";\n',
    "apps/worker/src/services/comment.ts": '// import { db } from "../db/client.js";\nconst text = "db/client";\n',
    "apps/worker/src/services/ignored.test.ts": 'import { db } from "../db/client.js"; void db;\n',
  }));
  // Coverage is derived from apps/ and packages/, so both parents are anchors.
  mkdirSync(join(root, "packages"), { recursive: true });
  const fail = gate("db-client-fence.mjs", ["--root", root], root);
  assert.equal(fail.status, gateFailure, fail.stderr || fail.stdout);
  assert.match(fail.stdout, /services\/static\.ts/u);
  assert.match(fail.stdout, /services\/barrel\.ts/u);
  assert.match(fail.stdout, /services\/drizzle\.ts/u);
  assert.match(fail.stdout, /services\/drizzle-subpath\.ts/u);
  assert.match(fail.stdout, /services\/drizzle-mixed\.ts/u);
  assert.match(fail.stdout, /services\/schema\.ts/u);
  assert.match(fail.stdout, /services\/schema-barrel\.ts/u);
  assert.doesNotMatch(fail.stdout, /services\/allowed-types\.ts/u);
  assert.doesNotMatch(fail.stdout, /services\/allowed-inline-types\.ts/u);
  assert.doesNotMatch(fail.stdout, /services\/allowed-inline-reexport\.ts/u);

  await Promise.all([
    "static.ts", "multiline.ts", "side-effect.ts", "type.ts", "dynamic.ts",
    "exported.ts", "mocked.ts", "barrel.ts", "drizzle.ts",
    "drizzle-subpath.ts", "drizzle-mixed.ts", "schema.ts", "schema-barrel.ts",
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
  assert.match(pass.stdout, /production raw database reachability\s+0/u);
});

test("a reintroduced definition schema branch fails the single schema version gate", async () => {
  const root = singleSchemaRoot("single-schema-gate-");
  const source = join(root, "apps/worker/src/engine/definition");
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
  assert.match(result.stdout, /apps\/worker\/src\/engine\/definition\/planner\.ts/u);
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
      file: "apps/worker/src/engine/definition/stored-definition.ts",
      contents: "export type Runtime = WorkflowDefinitionV1;\n",
      match: /WorkflowDefinitionV1/u,
    },
    {
      file: "apps/worker/src/engine/definition/stored-definition.ts",
      contents: "export const runtime = executeRetiredDefinition;\n",
      match: /executeRetiredDefinition/u,
    },
  ];

  for (const [index, fixture] of fixtures.entries()) {
    const root = singleSchemaRoot(`single-schema-adversarial-${index}-`, {
      [fixture.file]: fixture.contents,
    });
    const result = gate("single-schema-version.mjs", ["--root", root]);
    assert.equal(result.status, gateFailure, result.stderr || result.stdout);
    assert.match(result.stdout, fixture.match);
  }
});

test("an unrelated harness profile schema version branch passes the single schema version gate", () => {
  const root = singleSchemaRoot("single-schema-harness-pass-", {
    "apps/worker/src/harness-profiles/manifest.ts":
      "export const oldManifest = (schemaVersion: number) => schemaVersion === 1;\n",
  });
  const result = gate("single-schema-version.mjs", ["--root", root]);
  assert.equal(result.status, gateSuccess, result.stderr || result.stdout);
  assert.match(result.stdout, /single-schema-version PASS/u);
});

test("a harness profile importing a local re-export is scanned for retired version helpers", () => {
  const root = singleSchemaRoot("single-schema-harness-local-import-", {
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
