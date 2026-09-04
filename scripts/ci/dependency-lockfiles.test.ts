import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

test("repository tracks only the approved pnpm lockfiles", () => {
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

  assert.deepEqual(trackedLockfiles, [
    "apps/worker/test-fixtures/better-auth-1.6.30/pnpm-lock.yaml",
    "pnpm-lock.yaml",
  ]);
});
