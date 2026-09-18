#!/usr/bin/env node
/* oxlint-disable eslint/sort-vars, unicorn/no-array-sort */
/**
 * Drizzle, the database client, and table schemas are db-tier implementation
 * details. This gate fails when a production file reaches them through value
 * imports, directly or through a re-exporting local barrel. The existing
 * db/client rule also includes type imports. Tests, fixtures, e2e, test
 * support, and test-db are intentionally excluded.
 *
 * Where the gate looks is derived, never listed: every workspace project under
 * apps/ and packages/, so the dashboard and the shared packages are fenced off
 * the database on the same terms as the worker, and a project added tomorrow is
 * covered the day it appears. Only the exclusions are explicit, in EXCLUSIONS,
 * each carrying the reason it is out.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { parseOptions, printTable, requireAnchor, requireScan } from "./shared.mjs";

const WORKSPACE_PARENTS = ["apps", "packages"];
const CLIENT_MODULE = "apps/worker/src/db/client.ts";
const SCHEMA_MODULE = "apps/worker/src/db/schema.ts";
const SCHEMA_DIRECTORY = "apps/worker/src/db/schema";
const INVARIANT = "the fence keeping production files off the raw database";

/*
 * The only paths deliberately left out, each with the reason it is out. None of
 * them was scanned before this list existed either, so nothing that was checked
 * has stopped being checked; a new directory inside any project is covered by
 * default and has to be named here to stop being covered.
 */
const EXCLUSIONS = [
  {
    path: "apps/worker/src/db",
    reason: "the db tier is the thing being fenced off, not a caller of it",
  },
  {
    path: "apps/worker/scripts",
    reason: "migration and cleanup scripts run outside the request path and have to reach the database directly",
  },
];

/*
 * Generated output is not source. Walking it would be slow and would report
 * findings nobody can fix in the tree they are looking at.
 */
const SKIPPED_DIRECTORIES = new Set([
  ".next",
  ".nitro",
  ".output",
  ".turbo",
  ".vercel",
  "coverage",
  "dist",
  "node_modules",
]);

/*
 * "@/" means a different directory in each app: apps/dashboard/tsconfig.json
 * maps it to the dashboard root, while the worker declares no paths at all.
 * Resolving every alias against the worker would send a dashboard import to a
 * worker file that does not exist, and the fence would report nothing where
 * there is something.
 */
const ALIAS_ROOTS = [
  { aliases: [["@/", "apps/dashboard"]], project: "apps/dashboard" },
  { aliases: [["@/", "apps/worker/src"], ["~/", "apps/worker/src"]], project: "apps/worker" },
];

const productionTypeScript = /\.[cm]?[jt]sx?$/u;
const testPath = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|\/(?:test-support|e2e|fixtures)\/|\/test-db\.[cm]?[jt]s$)/u;
const mockPattern = /\b(?:vi\.)?(?:mock|doMock)\s*\(\s*["']([^"']+)["']/gu;

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : sourceFiles(path);
    return entry.isFile() && productionTypeScript.test(entry.name) ? [path] : [];
  });
}

/** Every workspace project under apps/ and packages/, in sorted order. */
function projectRoots(root) {
  const roots = [];
  for (const parent of WORKSPACE_PARENTS) {
    requireAnchor(root, parent, "a workspace parent this gate derives its roots from", INVARIANT);
    for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
      if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) roots.push(`${parent}/${entry.name}`);
    }
  }
  requireScan(roots.length, "workspace projects", WORKSPACE_PARENTS.join(", "), INVARIANT);
  return roots.toSorted();
}

function isExcluded(path) {
  return EXCLUSIONS.some((entry) => path === entry.path || path.startsWith(`${entry.path}/`));
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

/** The directory the importing project maps this alias to, or null. */
function aliasBase(root, file, specifier) {
  const path = relative(root, file).replaceAll("\\", "/");
  const owner = ALIAS_ROOTS.find((entry) => path.startsWith(`${entry.project}/`));
  return owner?.aliases.find(([prefix]) => specifier.startsWith(prefix))?.[1] ?? null;
}

function resolveLocal(root, file, specifier) {
  let target;
  if (specifier.startsWith(".")) target = resolve(dirname(file), specifier);
  else {
    const base = aliasBase(root, file, specifier);
    if (!base) return null;
    target = join(root, base, specifier.slice(2));
  }
  const extension = extname(target);
  const candidates = extension
    ? [target.replace(/\.(?:m?js|cjs)$/u, ".ts")]
    : [target, `${target}.ts`, `${target}.tsx`, join(target, "index.ts")];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

function isClientModule(root, target) {
  return target === join(root, CLIENT_MODULE);
}

function isSchemaModule(root, target) {
  const schema = join(root, SCHEMA_DIRECTORY);
  return target === `${schema}.ts` || target.startsWith(`${schema}/`);
}

/**
 * The fence is a comparison against two paths. If either one moves, every
 * import of it resolves to something the comparison no longer recognizes and
 * the gate reports reachability 0 with the imports still in place.
 */
function requireFenceAnchors(root) {
  requireAnchor(root, CLIENT_MODULE, "the database client module the fence compares against", INVARIANT);
  if (!existsSync(join(root, SCHEMA_MODULE)) && !existsSync(join(root, SCHEMA_DIRECTORY))) {
    throw new Error(
      `the database schema module the fence compares against is missing at both ${SCHEMA_MODULE} and ${SCHEMA_DIRECTORY}, so ${INVARIANT} is unproven. Restore that path or point the gate at where it moved.`,
    );
  }
}

function isDrizzleModule(specifier) {
  return specifier === "drizzle-orm" || specifier.startsWith("drizzle-orm/");
}

function main() {
  const options = parseOptions(process.argv.slice(2), { "--root": "root" });
  const root = options.root;
  requireFenceAnchors(root);
  const roots = projectRoots(root);
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
  const production = roots
    .flatMap((project) => sourceFiles(join(root, project)))
    .filter((file) => !testPath.test(relative(root, file).replaceAll("\\", "/")))
    .filter((file) => !isExcluded(relative(root, file).replaceAll("\\", "/")));
  requireScan(production.length, "production files", WORKSPACE_PARENTS.join(", "), INVARIANT);
  const paths = production
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
  printTable(["metric", "now"], [
    ["production files scanned", production.length],
    ["production raw database reachability", paths.length],
  ]);
  if (paths.length > 0) {
    console.log(paths.join("\n"));
    console.log("db-client-fence FAIL");
    process.exitCode = 1;
  } else {
    console.log(
      `db-client-fence PASS: ${production.length} production file(s) scanned across ${roots.length} workspace project(s)`,
    );
  }
}

try { main(); } catch (error) {
  console.error(`db-client-fence FAIL: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
