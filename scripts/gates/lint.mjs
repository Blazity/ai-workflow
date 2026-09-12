/**
 * This gate runs oxlint as a hard check. Any diagnostic fails the gate and
 * every diagnostic is printed with its file, line, column, rule, and message.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  parseOptions,
  repositoryRoot,
  runTool,
} from "./shared.mjs";

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
  const targets = ["apps/worker", "apps/dashboard", "scripts", "packages"]
    .filter((path) => existsSync(join(options.root, path)));
  const result = runTool(
    "oxlint",
    ["--config", config, "--format", "json", ...targets],
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
  console.log("Lint diagnostics");
  for (const diagnostic of diagnostics) console.log(diagnosticLine(diagnostic));
  console.log(diagnostics.length > 0 ? "lint FAIL" : "lint PASS");
  process.exitCode = diagnostics.length > 0 ? 1 : 0;
}

try {
  main();
} catch (error) {
  console.error(`lint FAIL: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
