#!/usr/bin/env node
/**
 * Neon HTTP has no interactive transactions. This heuristic catches a
 * function that awaits multiple database writes outside the repository tier,
 * where a multi-row change should be one statement instead.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { parseOptions, printTable, readJson } from "./shared.mjs";

const sourceExtension = /\.[cm]?[jt]sx?$/u;
const testPath = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|\/(?:test-support|e2e|fixtures)\/)/u;
const databaseWriteMethods = new Set(["insert", "update", "delete", "execute"]);

function sourceFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && sourceExtension.test(entry.name) ? [path] : [];
  });
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
  const allowlist = readJson(allowlistPath);
  if (!Array.isArray(allowlist) || allowlist.some((path) => typeof path !== "string" || !path)) {
    throw new Error("The consecutive-writes allowlist must be a list of non-empty strings.");
  }
  const allowed = new Set(allowlist);
  const source = join(root, "apps/worker/src");
  const rows = sourceFiles(source)
    .map((file) => [file, relative(root, file).replaceAll("\\", "/")])
    .filter(([, path]) => !path.startsWith("apps/worker/src/db/repositories/"))
    .filter(([, path]) => !testPath.test(path))
    .filter(([, path]) => !allowed.has(path))
    .flatMap(([file]) => findingsForFile(file, root))
    .sort();
  printTable(["function", "state"], rows.map((row) => [row, "multiple awaited writes"]));
  if (rows.length > 0) {
    console.log("consecutive-writes FAIL");
    process.exitCode = 1;
  } else {
    console.log("consecutive-writes PASS: 0 functions with multiple awaited db writes");
  }
}

try {
  main();
} catch (error) {
  console.error(`consecutive-writes FAIL: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
