#!/usr/bin/env node
/* oxlint-disable eslint/sort-vars, unicorn/no-array-sort */
/**
 * The database client is a db-tier implementation detail. This shrink-only
 * ratchet counts production worker files outside src/db that reach db/client
 * directly or through a re-exporting local barrel. Tests, fixtures, e2e,
 * test support, and test-db are intentionally excluded.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOptions, printTable, readJson, writeJson } from "./shared.mjs";

const productionTypeScript = /\.[cm]?[jt]sx?$/u;
const testPath = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|\/(?:test-support|e2e|fixtures)\/|\/test-db\.[cm]?[jt]s$)/u;
const importPattern = /\b(?:import|export)\s+(?:type\s+)?[^\n;]*?\s+from\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\b(?:vi\.)?(?:mock|doMock)\s*\(\s*["']([^"']+)["']/gu;

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && productionTypeScript.test(entry.name) ? [path] : [];
  });
}

function withoutComments(source) {
  let output = "", quote = null, escaped = false, line = false, block = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index], next = source[index + 1];
    if (line) { if (character === "\n") { line = false; output += character; } else output += " "; continue; }
    if (block) { if (character === "*" && next === "/") { block = false; output += "  "; index += 1; } else output += character === "\n" ? "\n" : " "; continue; }
    if (quote) { output += character; if (escaped) escaped = false; else if (character === "\\") escaped = true; else if (character === quote) quote = null; continue; }
    if (character === "'" || character === '"' || character === "`") { quote = character; output += character; continue; }
    if (character === "/" && next === "/") { line = true; output += "  "; index += 1; continue; }
    if (character === "/" && next === "*") { block = true; output += "  "; index += 1; continue; }
    output += character;
  }
  return output;
}

function imports(file) {
  const source = withoutComments(readFileSync(file, "utf8")), found = [];
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier) found.push({
      reexport: match[0].trimStart().startsWith("export"),
      specifier,
    });
  }
  return found;
}

function resolveLocal(root, file, specifier) {
  let target;
  if (specifier.startsWith(".")) target = resolve(dirname(file), specifier);
  else if (specifier.startsWith("@/")) target = join(root, "apps/worker/src", specifier.slice(2));
  else if (specifier.startsWith("~/")) target = join(root, "apps/worker/src", specifier.slice(2));
  else return null;
  const extension = extname(target);
  const candidates = extension
    ? [target.replace(/\.(?:m?js|cjs)$/u, ".ts")]
    : [target, `${target}.ts`, `${target}.tsx`, join(target, "index.ts")];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

function isClientModule(root, target) {
  return target === join(root, "apps/worker/src/db/client.ts");
}

function main() {
  const options = parseOptions(process.argv.slice(2), { "--baseline": "baseline", "--root": "root" });
  const root = options.root;
  const source = join(root, "apps/worker/src");
  const reexportCache = new Map();
  const reexportsClient = (file, visiting = new Set()) => {
    if (reexportCache.has(file)) return reexportCache.get(file);
    if (visiting.has(file)) return false;
    visiting.add(file);
    const result = imports(file).some(({ reexport, specifier }) => {
      if (!reexport) return false;
      const target = resolveLocal(root, file, specifier);
      return target && (isClientModule(root, target) || reexportsClient(target, visiting));
    });
    visiting.delete(file);
    reexportCache.set(file, result);
    return result;
  };
  const paths = sourceFiles(source)
    .filter((file) => !testPath.test(relative(root, file).replaceAll("\\", "/")))
    .filter((file) => !file.startsWith(join(source, "db")))
    .filter((file) => imports(file).some(({ specifier }) => {
      const target = resolveLocal(root, file, specifier);
      return target && (isClientModule(root, target) || reexportsClient(target));
    }))
    .map((file) => relative(root, file).replaceAll("\\", "/"))
    .sort();
  const baselinePath = options.baseline ?? fileURLToPath(new URL("./db-client-fence.baseline.json", import.meta.url));
  if (options.updateBaseline) writeJson(baselinePath, { count: paths.length });
  const baseline = readJson(baselinePath);
  if (!Number.isInteger(baseline.count) || baseline.count < 0) throw new Error("Baseline count must be a non-negative integer.");
  printTable(["metric", "baseline", "now"], [["production db/client reachability", baseline.count, paths.length]]);
  if (paths.length > baseline.count) {
    console.log(paths.join("\n"));
    console.log("db-client-fence FAIL");
    process.exitCode = 1;
  } else console.log("db-client-fence PASS");
}

try { main(); } catch (error) {
  console.error(`db-client-fence FAIL: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
