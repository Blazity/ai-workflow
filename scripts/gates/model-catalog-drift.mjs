/**
 * Product model identifiers have one owner. These exclusions are deliberately
 * narrow: tests assert behavior, capture tooling records external protocols,
 * and the dashboard activity drawer is presentation-only mock data.
 */
const EXCLUSIONS = [
  "**/*.test.*",
  "apps/dashboard/components/cockpit/activity-drawer.tsx",
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
    path === "apps/worker/scripts/capture-agent-protocol-fixtures.ts" ||
    /(?:^|\/)\w[^/]*\.test\.[^/]+$/u.test(path)
  );
}

function scanLineComment(character) {
  return character === "\n"
    ? { output: character, state: "code", advance: 0 }
    : { output: " ", state: "line-comment", advance: 0 };
}

function scanBlockComment(character, next) {
  if (character === "*" && next === "/") {
    return { output: "  ", state: "code", advance: 1 };
  }
  return {
    output: character === "\n" ? character : " ",
    state: "block-comment",
    advance: 0,
  };
}

function scanString(character, next, quote) {
  if (character === "\\") {
    return {
      output: character + (next ?? ""),
      state: "string",
      advance: 1,
    };
  }
  return {
    output: character,
    state: character === quote ? "code" : "string",
    advance: 0,
  };
}

function scanCode(character, next) {
  if (character === "/" && next === "/") {
    return { output: "  ", state: "line-comment", advance: 1 };
  }
  if (character === "/" && next === "*") {
    return { output: "  ", state: "block-comment", advance: 1 };
  }
  if (character === '"' || character === "'" || character === "`") {
    return {
      output: character,
      state: "string",
      advance: 0,
      quote: character,
    };
  }
  return { output: character, state: "code", advance: 0 };
}

function scanCharacter(state, character, next, quote) {
  if (state === "line-comment") return scanLineComment(character);
  if (state === "block-comment") return scanBlockComment(character, next);
  if (state === "string") return scanString(character, next, quote);
  return scanCode(character, next);
}

function withoutComments(source) {
  let result = "";
  let state = "code";
  let quote = "";

  for (let index = 0; index < source.length; index++) {
    const scanned = scanCharacter(
      state,
      source[index],
      source[index + 1],
      quote,
    );
    result += scanned.output;
    index += scanned.advance;
    state = scanned.state;
    if (scanned.quote) quote = scanned.quote;
  }

  return result;
}

function violations(root) {
  return ["apps", "packages"]
    .flatMap((directory) => walk(join(root, directory)))
    .map((file) => ({ file, path: relative(root, file).replaceAll("\\", "/") }))
    .filter(({ path }) => SOURCE_FILE.test(path) && !isExcluded(path))
    .flatMap(({ file, path }) =>
      withoutComments(readFileSync(file, "utf8"))
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
