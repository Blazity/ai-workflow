/**
 * This gate ratchets oxlint correctness errors and every other rule by warning
 * count. It exits 1 on tool failure or growth above either per-rule baseline.
 * Run with --update-baseline after reviewing count changes.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseOptions,
  printTable,
  readJson,
  repositoryRoot,
  runTool,
  sortedObject,
  writeJson,
} from "./shared.mjs";

const defaultBaseline = fileURLToPath(new URL("./lint.baseline.json", import.meta.url));

function diagnosticLine(diagnostic) {
  const span = diagnostic.labels?.find((label) => label.span)?.span;
  const location = span
    ? `${span.line}:${span.column}`
    : "?:?";
  return `${diagnostic.filename ?? "<unknown>"}:${location} ${diagnostic.code ?? "unknown"} ${diagnostic.message}`;
}

function lintRegression(current, baseline) {
  return Object.entries(current).some(([rule, count]) => {
    const baselineCount = baseline[rule] ?? 0;
    return count > 0 && (baselineCount === 0 || count > baselineCount);
  });
}

function main() {
  const options = parseOptions(process.argv.slice(2), {
    "--root": "root",
    "--baseline": "baseline",
    "--config": "config",
  });
  const baselinePath = options.baseline ?? defaultBaseline;
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
  const warnings = new Map();
  const correctnessErrors = new Map();
  for (const diagnostic of report.diagnostics ?? []) {
    const rule = diagnostic.code || "unknown";
    if (diagnostic.severity === "error") {
      correctnessErrors.set(rule, (correctnessErrors.get(rule) ?? 0) + 1);
    }
    else if (diagnostic.severity === "warning") {
      warnings.set(rule, (warnings.get(rule) ?? 0) + 1);
    }
  }
  const current = {
    correctnessErrors: sortedObject(correctnessErrors),
    warnings: sortedObject(warnings),
  };
  if (options.updateBaseline) writeJson(baselinePath, current);
  const baseline = options.updateBaseline ? current : readJson(baselinePath);
  const errorKeys = [
    ...new Set([
      ...Object.keys(current.correctnessErrors),
      ...Object.keys(baseline.correctnessErrors ?? {}),
    ]),
  ].sort();
  console.log("Lint correctness errors");
  printTable(
    ["rule", "baseline", "now"],
    errorKeys.map((rule) => [
      rule,
      baseline.correctnessErrors?.[rule] ?? 0,
      current.correctnessErrors[rule] ?? 0,
    ]),
  );
  const warningKeys = [
    ...new Set([...Object.keys(current.warnings), ...Object.keys(baseline.warnings ?? {})]),
  ].sort();
  const allRows = warningKeys.map((rule) => [
    rule,
    baseline.warnings?.[rule] ?? 0,
    current.warnings[rule] ?? 0,
  ]);
  const changedRows = allRows.filter((row) => row[1] !== row[2]);
  const total = (warnings) => Object.values(warnings).reduce((sum, count) => sum + count, 0);
  const rows = changedRows.length > 0
    ? changedRows
    : [["all rules", total(baseline.warnings ?? {}), total(current.warnings)]];
  console.log("Lint warnings");
  printTable(["rule", "baseline", "now"], rows);
  const failed = lintRegression(
    current.correctnessErrors,
    baseline.correctnessErrors ?? {},
  ) || lintRegression(current.warnings, baseline.warnings ?? {});
  if (failed) {
    console.log("Lint diagnostics");
    for (const diagnostic of report.diagnostics ?? []) {
      console.log(diagnosticLine(diagnostic));
    }
  }
  if (options.updateBaseline) console.log(`Updated ${baselinePath}`);
  console.log(failed ? "lint FAIL" : "lint PASS");
  process.exitCode = failed ? 1 : 0;
}

try {
  main();
} catch (error) {
  console.error(`lint FAIL: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
