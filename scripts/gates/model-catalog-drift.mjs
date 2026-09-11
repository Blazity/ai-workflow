/**
 * Product model identifiers have one owner. These exclusions are deliberately
 * narrow: tests assert behavior, capture tooling records external protocols,
 * and the two dashboard files are presentation-only mock data.
 */
const EXCLUSIONS = [
  "**/*.test.*",
  "apps/dashboard/components/cockpit/activity-drawer.tsx",
  "apps/dashboard/lib/data/mock.ts",
  "apps/worker/scripts/capture-agent-protocol-fixtures.ts",
  "packages/harness/model-catalog.ts",
];

const MODEL_LITERAL = /claude-(?:opus|sonnet|haiku|fable)-|gpt-5/u;
const SOURCE_FILE = /\.(?:c|m)?(?:j|t)sx?$|\.json$/u;
const GENERATED_DIRECTORIES = new Set([
  ".next",
  ".nitro",
  ".output",
  ".vercel",
  "dist",
  "node_modules",
]);

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

function parseArgs(argv) {
  let root = process.cwd();
  let printExclusions = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--root") {
      root = argv[++index];
      if (!root) throw new Error("--root requires a path");
    } else if (argument === "--print-exclusions") {
      printExclusions = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { printExclusions, root };
}

function walk(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return GENERATED_DIRECTORIES.has(entry.name) ? [] : walk(path);
    }
    return entry.isFile() ? [path] : [];
  });
}

function isExcluded(path) {
  return (
    path === "packages/harness/model-catalog.ts" ||
    path === "apps/dashboard/components/cockpit/activity-drawer.tsx" ||
    path === "apps/dashboard/lib/data/mock.ts" ||
    path === "apps/worker/scripts/capture-agent-protocol-fixtures.ts" ||
    /(?:^|\/)\w[^/]*\.test\.[^/]+$/u.test(path)
  );
}

function violations(root) {
  return ["apps", "packages"]
    .flatMap((directory) => walk(join(root, directory)))
    .map((file) => ({ file, path: relative(root, file).replaceAll("\\", "/") }))
    .filter(({ path }) => SOURCE_FILE.test(path) && !isExcluded(path))
    .flatMap(({ file, path }) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          MODEL_LITERAL.test(line) ? [`${path}:${index + 1}:${line.trim()}`] : [],
        ),
    );
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.printExclusions) {
    console.log(EXCLUSIONS.join("\n"));
    return;
  }
  const found = violations(options.root);
  if (found.length > 0) {
    console.log(found.join("\n"));
    console.log("model-catalog-drift FAIL");
    process.exitCode = 1;
    return;
  }
  console.log("model-catalog-drift PASS");
}

try {
  main();
} catch (error) {
  console.error(
    `model-catalog-drift FAIL: ${error instanceof Error ? error.message : error}`,
  );
  process.exitCode = 1;
}
