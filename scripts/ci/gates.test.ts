import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const boundaryFixture = (root: string): string => {
    const source = join(root, "apps/worker/src");
    mkdirSync(join(source, "routes"), { recursive: true });
    mkdirSync(join(source, "db"), { recursive: true });
    writeFileSync(join(source, "db/client.ts"), "export const db = 1;\n");
    writeFileSync(join(source, "routes/entry.ts"), 'import { db } from "../db/client.js";\nvoid db;\n');
    writeFileSync(join(root, "boundaries.baseline.json"), '{"tierPairs":{},"cycles":{},"cycleTotal":0}\n');
    return root;
  },
  gateFailure = 1,
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

test("the boundary baseline passes and is stable across file renames", async () => {
  const recorded = gate("boundaries.mjs");
  assert.equal(recorded.status, 0, recorded.stderr || recorded.stdout);

  const root = await mkdtemp(join(tmpdir(), "boundary-gate-"));
  const source = join(root, "apps/worker/src");
  const baseline = join(root, "boundaries.baseline.json");
  boundaryFixture(root);

  const common = ["--root", root, "--baseline", baseline];
  const updated = gate("boundaries.mjs", [...common, "--update-baseline"]);
  assert.equal(updated.status, 0, updated.stderr || updated.stdout);
  const before = gate("boundaries.mjs", common);
  assert.equal(before.status, 0, before.stderr || before.stdout);

  await rename(join(source, "routes/entry.ts"), join(source, "routes/renamed.ts"));
  const after = gate("boundaries.mjs", common);
  assert.equal(after.status, 0, after.stderr || after.stdout);
  assert.equal(after.stdout, before.stdout);

  await writeFile(join(source, "routes/second.ts"), 'import { db } from "../db/client.js";\nvoid db;\n');
  const regression = gate("boundaries.mjs", common);
  assert.equal(regression.status, 1, regression.stderr || regression.stdout);
  assert.match(regression.stdout, /app->db\s+1\s+2/);
});

test("an unknown worker source path fails the boundary gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "boundary-unknown-gate-"));
  const source = join(root, "apps/worker/src/unknown-tier");
  const baseline = join(root, "boundaries.baseline.json");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "x.ts"), "export const value = 1;\n");
  await writeFile(baseline, '{"tierPairs":{},"cycles":{},"cycleTotal":0}\n');

  const result = gate("boundaries.mjs", ["--root", root, "--baseline", baseline]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /Unknown paths\napps\/worker\/src\/unknown-tier\/x\.ts/);
});

test("the boundary gate reads a fixture the same way at any path depth", () => {
  const base = mkdtempSync(join(tmpdir(), "boundary-depth-gate-")),
    deepRoot = boundaryFixture(join(base, "far/down/the/tree")),
    nearRoot = boundaryFixture(join(base, "near")),
    runDeep = gate("boundaries.mjs", ["--root", deepRoot, "--baseline", join(deepRoot, "boundaries.baseline.json")]),
    runNear = gate("boundaries.mjs", ["--root", nearRoot, "--baseline", join(nearRoot, "boundaries.baseline.json")]);
  assert.equal(runNear.status, gateFailure, runNear.stderr || runNear.stdout);
  assert.equal(runDeep.status, gateFailure, runDeep.stderr || runDeep.stdout);
  assert.match(runNear.stdout, /app->db\s+0\s+1/u);
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

test("a workspace package without a description fails package contracts", async () => {
  const root = await mkdtemp(join(tmpdir(), "package-contracts-gate-"));
  const directory = join(root, "apps/shared/conditions");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), '{"name":"@shared/conditions"}\n');

  const result = gate("package-contracts.mjs", ["--root", root]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /apps\/shared\/conditions\/package\.json/);
});

test("gate baselines are machine readable JSON", async () => {
  for (const file of [
    "boundaries.baseline.json",
    "unused-code.baseline.json",
    "lint.baseline.json",
    "no-resurrected-paths.json",
  ]) {
    JSON.parse(await readFile(join(repoRoot, "scripts/gates", file), "utf8"));
  }
});
