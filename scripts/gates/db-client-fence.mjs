#!/usr/bin/env node
/* oxlint-disable eslint/sort-vars, unicorn/no-array-sort */
/**
 * Drizzle, the database client, and table schemas are db-tier implementation
 * details. This gate fails when production worker files outside src/db reach
 * them through value imports, directly or through a re-exporting local barrel.
 * The existing db/client rule also includes type imports. Tests, fixtures,
 * e2e, test support, and test-db are intentionally excluded.
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

function inlineNamedClauseIsTypeOnly(tokens, start, end) {
  if (tokens[start]?.value !== "{") return false;
  let found = false;
  for (let cursor = start + 1; cursor < end;) {
    if (tokens[cursor]?.value === ",") { cursor += 1; continue; }
    if (tokens[cursor]?.value === "}") return found && cursor === end - 1;
    if (
      tokens[cursor]?.kind !== "word" || tokens[cursor].value !== "type" ||
      tokens[cursor + 1]?.value === "as" || tokens[cursor + 1]?.value === "," ||
      tokens[cursor + 1]?.value === "}"
    ) return false;
    found = true;
    cursor += 2;
    while (cursor < end && tokens[cursor]?.value !== "," && tokens[cursor]?.value !== "}") {
      cursor += 1;
    }
  }
  return false;
}

function staticAndDynamicImports(source) {
  const tokens = moduleTokens(source), found = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== "word" || (token.value !== "import" && token.value !== "export")) continue;
    const reexport = token.value === "export", next = tokens[index + 1];
    const clauseTypeOnly = next?.kind === "word" && next.value === "type";
    if (!reexport && next?.kind === "string") {
      found.push({ reexport: false, specifier: next.value, typeOnly: false });
      continue;
    }
    if (
      !reexport && next?.value === "(" &&
      tokens[index + 2]?.kind === "string" && tokens[index + 3]?.value === ")"
    ) {
      found.push({ reexport: false, specifier: tokens[index + 2].value, typeOnly: false });
      continue;
    }
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const candidate = tokens[cursor];
      if (candidate.value === ";") break;
      if (
        candidate.kind === "word" && candidate.value === "from" &&
        tokens[cursor + 1]?.kind === "string"
      ) {
        const typeOnly = clauseTypeOnly || inlineNamedClauseIsTypeOnly(tokens, index + 1, cursor);
        found.push({ reexport, specifier: tokens[cursor + 1].value, typeOnly });
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
    if (match[1]) found.push({ reexport: false, specifier: match[1], typeOnly: false });
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

function isSchemaModule(root, target) {
  const schema = join(root, "apps/worker/src/db/schema");
  return target === `${schema}.ts` || target.startsWith(`${schema}/`);
}

function isDrizzleModule(specifier) {
  return specifier === "drizzle-orm" || specifier.startsWith("drizzle-orm/");
}

function main() {
  const options = parseOptions(process.argv.slice(2), { "--root": "root" });
  const root = options.root;
  const source = join(root, "apps/worker/src");
  const reexportCache = new Map();
  const reexportsRestrictedModule = (file, restriction, visiting = new Set()) => {
    const cacheKey = `${restriction}:${file}`;
    if (reexportCache.has(cacheKey)) return reexportCache.get(cacheKey);
    if (visiting.has(cacheKey)) return false;
    visiting.add(cacheKey);
    const result = imports(file).some(({ reexport, specifier, typeOnly }) => {
      if (!reexport) return false;
      const target = resolveLocal(root, file, specifier);
      if (restriction === "client") {
        return target && (
          isClientModule(root, target) ||
          reexportsRestrictedModule(target, restriction, visiting)
        );
      }
      if (typeOnly) return false;
      if (restriction === "drizzle" && isDrizzleModule(specifier)) return true;
      if (restriction === "schema" && target && isSchemaModule(root, target)) return true;
      return target && reexportsRestrictedModule(target, restriction, visiting);
    });
    visiting.delete(cacheKey);
    reexportCache.set(cacheKey, result);
    return result;
  };
  const paths = sourceFiles(source)
    .filter((file) => !testPath.test(relative(root, file).replaceAll("\\", "/")))
    .filter((file) => !file.startsWith(join(source, "db")))
    .filter((file) => imports(file).some(({ specifier, typeOnly }) => {
      const target = resolveLocal(root, file, specifier);
      if (target && (
        isClientModule(root, target) ||
        reexportsRestrictedModule(target, "client")
      )) return true;
      if (typeOnly) return false;
      if (isDrizzleModule(specifier)) return true;
      if (target && (
        isSchemaModule(root, target) ||
        reexportsRestrictedModule(target, "schema") ||
        reexportsRestrictedModule(target, "drizzle")
      )) return true;
      return false;
    }))
    .map((file) => relative(root, file).replaceAll("\\", "/"))
    .sort();
  printTable(["metric", "now"], [["production raw database reachability", paths.length]]);
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
