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

  const collected: string[] = [];
  for (const pattern of patterns) {
    for await (const file of glob(pattern, { cwd: root })) collected.push(file);
  }

  const onDisk = (await testFilesOnDisk("")).sort();
  assert.ok(onDisk.length >= 100, `walked ${onDisk.length} test files, expected the suite`);
  assert.deepEqual([...new Set(collected)].sort(), onDisk);
  // Two patterns reaching one file run it twice, and the only trace is a test
  // count nobody can account for.
  const twice = collected.filter((file, index) => collected.indexOf(file) !== index);
  assert.deepEqual(twice, [], `collected more than once: ${twice.join(", ")}`);
});

/**
 * A path this package holds that a literal positional cannot name.
 *
 * `node --test` globs its positionals, so a path is a PATTERN: the brackets of
 * a Next dynamic segment (`app/api/users/[userId]/...`) read as a character
 * class, the pattern matches nothing, and the run exits green two tests
 * lighter. That is how the same suite counted 1294 through the package script
 * and 1292 through a hand-written file list.
 *
 * `scripts/ci/verify-changed.ts` escapes every one of these characters before
 * it passes a changed file (`globLiteral`), which is what keeps the gate
 * honest. This asserts the rule it relies on: escaping each metacharacter as a
 * one-character class finds exactly that file, for every path in this package.
 */
test("every test file can be named literally, once escaped", async () => {
  const onDisk = await testFilesOnDisk("");
  const escape = (path: string): string => path.replace(/[?*()[\]{}]/g, "[$&]");

  for (const file of onDisk) {
    const matches: string[] = [];
    for await (const found of glob(escape(file), { cwd: root })) matches.push(found);
    assert.deepEqual(matches, [file], `${file} is not reachable as an escaped literal`);
  }

  // And at least one file in this package really does need the escape, so this
  // guard is exercised rather than vacuously true.
  assert.ok(
    onDisk.some((file) => escape(file) !== file),
    "no path here needs escaping any more; keep this guard only while one does",
  );
});
