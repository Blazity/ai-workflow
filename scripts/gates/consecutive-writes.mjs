#!/usr/bin/env node
/**
 * Neon HTTP has no interactive transactions. This heuristic catches a
 * function that awaits multiple database writes outside the repository tier,
 * where a multi-row change should be one statement instead.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOptions, printTable, readJson } from "./shared.mjs";

const sourceExtension = /\.[cm]?[jt]sx?$/u;
const testPath = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|\/(?:test-support|e2e|fixtures)\/)/u;
const awaitedWrite = /\bawait\s+db\.(?:insert|update|delete|execute)\b/gu;
const functionHeader = /(?:\basync\s+)?\bfunction(?:\s+[A-Za-z_$][\w$]*)?\s*(?:<[^{}]*>)?\s*\([^{}]*\)\s*\{|(?:\basync\s+)?(?:[A-Za-z_$][\w$]*|\([^{}]*\))\s*=>\s*\{|(?:\basync\s+)?(?!if\b|for\b|while\b|switch\b|catch\b)[A-Za-z_$][\w$]*\s*\([^{}]*\)\s*\{/gu;

function mask(source) {
  let output = "";
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        output += character;
      } else {
        output += " ";
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        output += "  ";
        index += 1;
      } else {
        output += character === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (quote !== null) {
      output += character === "\n" ? "\n" : " ";
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      output += "  ";
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      output += "  ";
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      output += " ";
      continue;
    }
    output += character;
  }
  return output;
}

function sourceFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && sourceExtension.test(entry.name) ? [path] : [];
  });
}

function closingBrace(source, openingBrace) {
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return source.length;
}

function functionBodies(source) {
  return [...source.matchAll(functionHeader)].flatMap((match) => {
    const openingBrace = match.index + match[0].lastIndexOf("{");
    const closing = closingBrace(source, openingBrace);
    return closing > openingBrace ? [{ openingBrace, closing }] : [];
  });
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

function findingsForFile(file, root) {
  const original = readFileSync(file, "utf8");
  const masked = mask(original);
  const bodies = functionBodies(masked).sort(
    (left, right) => (left.closing - left.openingBrace) - (right.closing - right.openingBrace),
  );
  const counts = new Map();
  for (const match of masked.matchAll(awaitedWrite)) {
    const body = bodies.find(
      (candidate) => match.index > candidate.openingBrace && match.index < candidate.closing,
    );
    if (!body) continue;
    const current = counts.get(body) ?? { count: 0, firstWrite: match.index };
    current.count += 1;
    counts.set(body, current);
  }
  const path = relative(root, file).replaceAll("\\", "/");
  return [...counts.values()]
    .filter(({ count }) => count >= 2)
    .map(({ count, firstWrite }) => `${path}:${lineOf(original, firstWrite)} (${count} awaited db writes)`);
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
