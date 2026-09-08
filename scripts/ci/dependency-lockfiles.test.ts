import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const javascriptLockfileNames = new Set([
  "bun.lock",
  "bun.lockb",
  "deno.lock",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

test("repository tracks only the root pnpm lockfile", () => {
  const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
  });

  const trackedLockfiles = trackedFiles
    .split("\0")
    .filter(Boolean)
    .filter((path) => {
      const basename = path.split("/").at(-1);
      return basename !== undefined && javascriptLockfileNames.has(basename);
    })
    .sort();

  assert.deepEqual(trackedLockfiles, ["pnpm-lock.yaml"]);
});

/**
 * Two of the pnpm overrides that carry AIW-323 are pinned to a specific parent
 * version: `@workflow/core@4.8>nanoid` and `next@15.5>postcss`. When either
 * parent moves to a new minor, its override stops matching, the transitive
 * dependency resolves freely again, and the advisory returns with no signal at
 * all: install still succeeds, the override is still present in package.json,
 * and nothing turns red.
 *
 * So assert the resolution itself rather than the override text. The expected
 * sets are exact on purpose. A benign upgrade failing this test is the point:
 * it forces someone to confirm the new version is still patched before the set
 * is updated, which is the check that silently disappears otherwise.
 */
test("advisory-patched dependencies resolve to their expected versions", async () => {
  const lockfile = await readFile("pnpm-lock.yaml", "utf8");
  const packagesSection = lockfile.slice(lockfile.indexOf("\npackages:"));

  // Lockfile v9 lists each key twice, once under `packages:` and once under
  // `snapshots:`, so collapse to the distinct set of resolved versions.
  const resolvedVersionsOf = (name: string): string[] => {
    const pattern = new RegExp(`^ {2}${name}@([^:(]+)[:(]`, "gm");
    const versions = [...packagesSection.matchAll(pattern)].map(
      (match) => match[1],
    );
    return [...new Set(versions)].sort();
  };

  assert.deepEqual(resolvedVersionsOf("nanoid"), ["3.3.18", "5.1.16"]);
  assert.deepEqual(resolvedVersionsOf("postcss"), ["8.5.28"]);
  assert.deepEqual(resolvedVersionsOf("qs"), ["6.16.0"]);
  assert.deepEqual(resolvedVersionsOf("undici"), ["7.29.0"]);
});
