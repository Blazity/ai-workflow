#!/usr/bin/env node
/* oxlint-disable eslint/no-shadow, eslint/sort-vars, unicorn/explicit-length-check */
/**
 * Neon HTTP has no interactive transactions. Production worker source must
 * therefore contain zero executable .transaction( calls. A repository-only
 * allowance may be considered in a future driver migration, but is dormant.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const source = join(root, "apps/worker/src");
const test = /(?:\.test|\.spec)\.[cm]?[jt]sx?$/u;
const skipped = new Set(["test-support", "e2e", "fixtures"]);

function mask(source) {
  let output = "", quote = null, line = false, block = false, escape = false;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i], next = source[i + 1];
    if (line) { if (c === "\n") { line = false; output += c; } else output += " "; continue; }
    if (block) { if (c === "*" && next === "/") { block = false; output += "  "; i += 1; } else output += c === "\n" ? "\n" : " "; continue; }
    if (quote) { output += c === "\n" ? "\n" : " "; if (escape) escape = false; else if (c === "\\") escape = true; else if (c === quote) quote = null; continue; }
    if (c === "/" && next === "/") { line = true; output += "  "; i += 1; continue; }
    if (c === "/" && next === "*") { block = true; output += "  "; i += 1; continue; }
    if (c === "'" || c === '"' || c === "`") { quote = c; output += " "; continue; }
    output += c;
  }
  return output;
}

function files(directory) {
  const entries = readdirSync(directory);
  return entries.flatMap((entry) => {
    const path = join(directory, entry), info = statSync(path);
    if (info.isDirectory()) return skipped.has(entry) ? [] : files(path);
    return /\.[cm]?[jt]sx?$/u.test(entry) && !test.test(entry) ? [path] : [];
  });
}

const rows = [];
for (const file of files(source)) {
  const contents = mask(readFileSync(file, "utf8"));
  for (const match of contents.matchAll(/\.[ \t\r\n]*transaction[ \t\r\n]*\(/gu)) {
    rows.push(`${relative(root, file)}:${contents.slice(0, match.index).split("\n").length}`);
  }
}
if (rows.length) {
  console.log(rows.join("\n"));
  console.log("transactions-in-repositories FAIL");
  process.exitCode = 1;
} else console.log("transactions-in-repositories PASS: 0 production transaction calls");
