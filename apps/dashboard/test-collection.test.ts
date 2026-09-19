import assert from "node:assert/strict";
import { glob, readFile, readdir } from "node:fs/promises";
import test from "node:test";

const root = `${import.meta.dirname}/`;

async function testFilesOnDisk(directory: string, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(`${root}${directory}`, { withFileTypes: true })) {
    // The dependency tree and build output hold no suite of ours.
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await testFilesOnDisk(`${relative}/`, relative)));
    else if (/\.test\.tsx?$/.test(entry.name)) found.push(relative);
  }
  return found;
}

/**
 * `node --test` globs its positionals, and a glob is not a directory walk: a
 * pattern that cannot reach a path shape drops those files while the run still
 * exits green. A pattern rooted at the package had no floor under it either,
 * so one install layout away it walked the dependency tree, not this package.
 *
 * Reading the patterns out of the script that ships and counting what they
 * reach against what is on disk is what turns either silence into a failure.
 */
test("the test script collects every test file in this package", async () => {
  const manifest = JSON.parse(await readFile(`${root}package.json`, "utf8")) as {
    scripts: { test: string };
  };
  const patterns = [...manifest.scripts.test.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(patterns.length > 0, "the test script passes its patterns quoted");

  const collected = new Set<string>();
  for (const pattern of patterns) {
    for await (const file of glob(pattern, { cwd: root })) collected.add(file);
  }

  const onDisk = (await testFilesOnDisk("")).sort();
  assert.ok(onDisk.length >= 100, `walked ${onDisk.length} test files, expected the suite`);
  assert.deepEqual([...collected].sort(), onDisk);
});
