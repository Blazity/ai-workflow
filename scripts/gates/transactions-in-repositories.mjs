#!/usr/bin/env node
/* oxlint-disable eslint/no-shadow, eslint/sort-vars, unicorn/explicit-length-check */
/**
 * Neon HTTP has no interactive transactions. Production source must therefore
 * contain zero executable .transaction( calls. A repository-only allowance may
 * be considered in a future driver migration, but is dormant.
 *
 * Where the gate looks is derived, never listed: every workspace project under
 * apps/ and packages/. Shared code runs inside the same function as the worker,
 * so a transaction opened there breaks production exactly the same way, and a
 * project added tomorrow is covered the day it appears. Only the exclusions are
 * explicit, each with the reason it is there.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { requireAnchor, requireScan } from "./shared.mjs";

const root = process.cwd();
const workspaceParents = ["apps", "packages"];
const invariant = "the rule that production source opens no transaction";
const test = /(?:\.test|\.spec)\.[cm]?[jt]sx?$/u;
const skipped = new Map([
  ["node_modules", "installed dependencies are not this repository's source"],
  [".next", "generated build output, not source"],
  [".nitro", "generated build output, not source"],
  [".output", "generated build output, not source"],
  [".vercel", "generated build output, not source"],
  [".turbo", "generated build output, not source"],
  ["coverage", "generated build output, not source"],
  ["dist", "generated build output, not source"],
  ["test-support", "test scaffolding runs on pglite, which does have transactions"],
  ["e2e", "test scaffolding runs on pglite, which does have transactions"],
  ["fixtures", "test scaffolding runs on pglite, which does have transactions"],
]);

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

/** Every workspace project under apps/ and packages/, in sorted order. */
function projectRoots() {
  const roots = [];
  for (const parent of workspaceParents) {
    requireAnchor(root, parent, "a workspace parent this gate derives its roots from", invariant);
    for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
      if (entry.isDirectory() && !skipped.has(entry.name)) roots.push(`${parent}/${entry.name}`);
    }
  }
  requireScan(roots.length, "workspace projects", workspaceParents.join(", "), invariant);
  return roots.toSorted();
}

function main() {
  const roots = projectRoots();
  const scanned = roots.flatMap((project) => files(join(root, project)));
  requireScan(scanned.length, "source files", workspaceParents.join(", "), invariant);
  const rows = [];
  for (const file of scanned) {
    const contents = mask(readFileSync(file, "utf8"));
    for (const match of contents.matchAll(/\.[ \t\r\n]*transaction[ \t\r\n]*\(/gu)) {
      rows.push(`${relative(root, file)}:${contents.slice(0, match.index).split("\n").length}`);
    }
  }
  if (rows.length) {
    console.log(rows.join("\n"));
    console.log("transactions-in-repositories FAIL");
    process.exitCode = 1;
  } else {
    console.log(
      `transactions-in-repositories PASS: 0 production transaction calls in ${scanned.length} scanned file(s) across ${roots.length} workspace project(s)`,
    );
  }
}

try {
  main();
} catch (error) {
  console.error(
    `transactions-in-repositories FAIL: ${error instanceof Error ? error.message : error}`,
  );
  process.exitCode = 1;
}
