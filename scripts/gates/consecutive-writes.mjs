#!/usr/bin/env node
/**
 * Neon HTTP has no interactive transactions. This heuristic catches a
 * function that awaits multiple database writes outside the repository tier,
 * where a multi-row change should be one statement instead.
 *
 * Where the gate looks is derived, never listed: every workspace project under
 * apps/ and packages/, whole, so shared code and worker tooling outside src/
 * are held to the same rule as the worker, and a project added tomorrow is
 * covered the day it appears. Only the exclusions are explicit, in EXCLUSIONS,
 * each carrying the reason it is out. Per-file exceptions stay in the allowlist.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { parseOptions, printTable, readJson, requireAnchor, requireScan } from "./shared.mjs";

const WORKSPACE_PARENTS = ["apps", "packages"];
const INVARIANT = "the rule that no function outside the repository tier awaits two database writes";
const EXCLUSIONS = [
  {
    path: "apps/worker/src/db/repositories",
    reason: "the repository tier is where a multi-row change is written as one statement; the rule polices its callers",
  },
];
// Generated output is not source, and walking it would report what nobody can fix.
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
const sourceExtension = /\.[cm]?[jt]sx?$/u;
const testPath = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|\/(?:test-support|e2e|fixtures)\/)/u;
const databaseWriteMethods = new Set(["insert", "update", "delete", "execute"]);

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : sourceFiles(path);
    return entry.isFile() && sourceExtension.test(entry.name) ? [path] : [];
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

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function functionBody(node) {
  return isFunctionLike(node) ? node.body : undefined;
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isAwaitedDatabaseWrite(expression) {
  let current = unwrapExpression(expression);
  let reachedWrite = false;

  while (true) {
    if (ts.isCallExpression(current)) {
      const callee = unwrapExpression(current.expression);
      if (ts.isPropertyAccessExpression(callee)) {
        if (databaseWriteMethods.has(callee.name.text)) reachedWrite = true;
        current = unwrapExpression(callee.expression);
        continue;
      }
      if (ts.isIdentifier(callee) && callee.text === "getDb") {
        return reachedWrite;
      }
      return false;
    }
    if (ts.isPropertyAccessExpression(current)) {
      current = unwrapExpression(current.expression);
      continue;
    }
    return reachedWrite && ts.isIdentifier(current) && current.text === "db";
  }
}

function awaitedDatabaseWrites(body) {
  const writes = [];
  const visit = (node) => {
    if (node !== body && isFunctionLike(node)) return;
    if (ts.isAwaitExpression(node) && isAwaitedDatabaseWrite(node.expression)) {
      writes.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return writes;
}

function findingsForFile(file, root) {
  const sourceFile = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.getScriptKindFromFileName(file),
  );
  const findings = [];
  const visit = (node) => {
    const body = functionBody(node);
    if (body) {
      const writes = awaitedDatabaseWrites(body);
      if (writes.length >= 2) {
        findings.push({ count: writes.length, firstWrite: writes[0].getStart(sourceFile) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const path = relative(root, file).replaceAll("\\", "/");
  return findings.map(({ count, firstWrite }) => {
    const line = sourceFile.getLineAndCharacterOfPosition(firstWrite).line + 1;
    return `${path}:${line} (${count} awaited db writes)`;
  });
}

function main() {
  const options = parseOptions(process.argv.slice(2), {
    "--root": "root",
    "--allowlist": "allowlist",
  });
  const root = options.root;
  const allowlistPath = options.allowlist ?? fileURLToPath(
    new URL("./consecutive-writes.allowlist.json", import.meta.url),
  );
  requireAnchor(root, allowlistPath, "the allowlist this gate reads", INVARIANT);
  const allowlist = readJson(allowlistPath);
  if (!Array.isArray(allowlist) || allowlist.some((path) => typeof path !== "string" || !path)) {
    throw new Error("The consecutive-writes allowlist must be a list of non-empty strings.");
  }
  const allowed = new Set(allowlist);
  const roots = projectRoots(root);
  const found = roots.flatMap((project) => sourceFiles(join(root, project)));
  requireScan(found.length, "source files", WORKSPACE_PARENTS.join(", "), INVARIANT);
  // EXCLUSIONS, tests and the allowlist are deliberate, so the examined count
  // is printed separately from the found count: a drop to zero examined is a
  // decision someone can see, not an accident nobody can.
  const examined = found
    .map((file) => [file, relative(root, file).replaceAll("\\", "/")])
    .filter(([, path]) => !isExcluded(path))
    .filter(([, path]) => !testPath.test(path))
    .filter(([, path]) => !allowed.has(path));
  const rows = examined.flatMap(([file]) => findingsForFile(file, root)).sort();
  printTable(["function", "state"], rows.map((row) => [row, "multiple awaited writes"]));
  if (rows.length > 0) {
    console.log("consecutive-writes FAIL");
    process.exitCode = 1;
  } else {
    console.log(
      `consecutive-writes PASS: 0 functions with multiple awaited db writes in ${examined.length} of ${found.length} scanned file(s) across ${roots.length} workspace project(s)`,
    );
  }
}

try {
  main();
} catch (error) {
  console.error(`consecutive-writes FAIL: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
