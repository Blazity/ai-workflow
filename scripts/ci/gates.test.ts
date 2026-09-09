import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "../..");

function gate(name: string, args: string[] = []) {
  return spawnSync(process.execPath, [join(repoRoot, "scripts/gates", name), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

test("the boundary baseline passes and is stable across file renames", async () => {
  const recorded = gate("boundaries.mjs");
  assert.equal(recorded.status, 0, recorded.stderr || recorded.stdout);

  const root = await mkdtemp(join(tmpdir(), "boundary-gate-"));
  const source = join(root, "apps/worker/src");
  const baseline = join(root, "boundaries.baseline.json");
  await mkdir(join(source, "routes"), { recursive: true });
  await mkdir(join(source, "db"), { recursive: true });
  await writeFile(join(source, "db/client.ts"), "export const db = 1;\n");
  await writeFile(join(source, "routes/entry.ts"), 'import { db } from "../db/client.js";\nvoid db;\n');

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
