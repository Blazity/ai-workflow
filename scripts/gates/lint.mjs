/**
 * This gate runs oxlint as a hard check. Any diagnostic fails the gate and
 * every diagnostic is printed with its file, line, column, rule, and message.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  parseOptions,
  repositoryRoot,
  requireAnchor,
  requireScan,
  runTool,
} from "./shared.mjs";

/*
 * What gets linted is derived, never listed: every directory under apps/, plus
 * the two shared trees. A new app is linted the day it appears, and a red gate
 * over code nobody has linted yet is the gate working. A missing root is a
 * refusal rather than a silent subtraction, which is what let a rename stop
 * being linted.
 *
 * Only the exclusions are explicit, each carrying the reason it is there.
 * Nothing is excluded today. changelog/ and skills/ are not listed because
 * they hold Markdown only, docs/ holds Markdown plus the research scripts knip
 * owns, and the repository root holds no lintable file.
 */
const APP_PARENT = "apps";
const SHARED_LINT_ROOTS = ["scripts", "packages"];
const LINT_EXCLUSIONS = [];
const INVARIANT = "the rule that the linted source carries no oxlint diagnostic";

function lintRoots(root) {
  requireAnchor(root, APP_PARENT, "the directory this gate derives its app roots from", INVARIANT);
  const apps = readdirSync(join(root, APP_PARENT), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${APP_PARENT}/${entry.name}`)
    .toSorted();
  requireScan(apps.length, "app directories", APP_PARENT, INVARIANT);
  for (const path of SHARED_LINT_ROOTS) {
    requireAnchor(root, path, "a shared lint root this gate declares", INVARIANT);
  }
  const excluded = new Map(LINT_EXCLUSIONS.map((entry) => [entry.path, entry.reason]));
  for (const [path, reason] of excluded) console.log(`lint skips ${path}: ${reason}`);
  return [...apps, ...SHARED_LINT_ROOTS].filter((path) => !excluded.has(path));
}

function diagnosticLine(diagnostic) {
  const span = diagnostic.labels?.find((label) => label.span)?.span;
  const location = span
    ? `${span.line}:${span.column}`
    : "?:?";
  return `${diagnostic.filename ?? "<unknown>"}:${location} ${diagnostic.code ?? "unknown"} ${diagnostic.message}`;
}

function main() {
  const options = parseOptions(process.argv.slice(2), {
    "--root": "root",
    "--config": "config",
  });
  const config = options.config ?? `${repositoryRoot}/.oxlintrc.json`;
  requireAnchor(options.root, config, "the oxlint configuration this gate reads", INVARIANT);
  const roots = lintRoots(options.root);
  const result = runTool(
    "oxlint",
    ["--config", config, "--format", "json", ...roots],
    options.root,
  );
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(`oxlint did not return JSON: ${result.stderr.trim()}`);
  }
  if (![0, 1].includes(result.status)) {
    throw new Error(`oxlint exited ${result.status}: ${result.stderr.trim()}`);
  }
  const diagnostics = report.diagnostics ?? [];
  const linted = report.number_of_files ?? 0;
  requireScan(linted, "files", roots.join(", "), INVARIANT);
  console.log("Lint diagnostics");
  for (const diagnostic of diagnostics) console.log(diagnosticLine(diagnostic));
  console.log(
    diagnostics.length > 0 ? "lint FAIL" : `lint PASS: ${linted} file(s) linted across ${roots.join(", ")}`,
  );
  process.exitCode = diagnostics.length > 0 ? 1 : 0;
}

try {
  main();
} catch (error) {
  console.error(`lint FAIL: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
