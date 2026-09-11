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
import { parseOptions, printTable } from "./shared.mjs";

const productionTypeScript = /\.[cm]?[jt]sx?$/u;
const testPath = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|\/(?:test-support|e2e|fixtures)\/|\/test-db\.[cm]?[jt]s$)/u;
const mockPattern = /\b(?:vi\.)?(?:mock|doMock)\s*\(\s*["']([^"']+)["']/gu;

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

function moduleTokens(source) {
  const tokens = [];
  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (/\s/u.test(character)) { index += 1; continue; }
    if (character === "'" || character === '"' || character === "`") {
      const quote = character;
      let value = "", escaped = false;
      index += 1;
      while (index < source.length) {
        const current = source[index];
        if (escaped) { value += current; escaped = false; index += 1; continue; }
        if (current === "\\") { value += current; escaped = true; index += 1; continue; }
        if (current === quote) { index += 1; break; }
        value += current;
        index += 1;
      }
      tokens.push({ kind: quote === "`" ? "template" : "string", value });
      continue;
    }
    if (/[A-Za-z_$]/u.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && /[\w$]/u.test(source[index])) index += 1;
      tokens.push({ kind: "word", value: source.slice(start, index) });
      continue;
    }
    tokens.push({ kind: "punctuation", value: character });
    index += 1;
  }
  return tokens;
}

function staticAndDynamicImports(source) {
  const tokens = moduleTokens(source), found = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== "word" || (token.value !== "import" && token.value !== "export")) continue;
    const reexport = token.value === "export", next = tokens[index + 1];
    if (!reexport && next?.kind === "string") {
      found.push({ reexport: false, specifier: next.value });
      continue;
    }
    if (
      !reexport && next?.value === "(" &&
      tokens[index + 2]?.kind === "string" && tokens[index + 3]?.value === ")"
    ) {
      found.push({ reexport: false, specifier: tokens[index + 2].value });
      continue;
    }
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const candidate = tokens[cursor];
      if (candidate.value === ";") break;
      if (
        candidate.kind === "word" && candidate.value === "from" &&
        tokens[cursor + 1]?.kind === "string"
      ) {
        found.push({ reexport, specifier: tokens[cursor + 1].value });
        break;
      }
    }
  }
  return found;
}

function imports(file) {
  const source = withoutComments(readFileSync(file, "utf8"));
  const found = staticAndDynamicImports(source);
  for (const match of source.matchAll(mockPattern)) {
    if (match[1]) found.push({ reexport: false, specifier: match[1] });
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
  const options = parseOptions(process.argv.slice(2), { "--root": "root" });
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
  printTable(["metric", "now"], [["production db/client reachability", paths.length]]);
  if (paths.length > 0) {
    console.log(paths.join("\n"));
    console.log("db-client-fence FAIL");
    process.exitCode = 1;
  } else console.log("db-client-fence PASS");
}

try { main(); } catch (error) {
  console.error(`db-client-fence FAIL: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
