/**
 * This gate prevents Knip findings from growing by workspace and category. It
 * exits 1 when Knip cannot run or any count exceeds its baseline. Run with
 * --update-baseline only after reviewing each changed count. knip.json ignores
 * generated files, build output, generated MCP data, sandbox agent fixtures,
 * and WDK fixtures because those paths are generated, vendored, or discovered
 * by runtimes that Knip cannot model.
 */
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

const defaultBaseline = fileURLToPath(new URL("./unused-code.baseline.json", import.meta.url));

function workspace(file) {
  const path = file.replaceAll("\\", "/");
  const match = path.match(
    /^(apps\/(?:worker|dashboard)|apps\/shared\/[^/]+|packages\/[^/]+)(?:\/|$)/,
  );
  return match?.[1] ?? "root";
}

function countsFrom(report) {
  const counts = new Map();
  for (const issue of report.issues ?? []) {
    const owner = workspace(issue.file ?? "");
    for (const [category, findings] of Object.entries(issue)) {
      if (category === "file" || !Array.isArray(findings) || findings.length === 0) continue;
      const key = `${owner}\0${category}`;
      counts.set(key, (counts.get(key) ?? 0) + findings.length);
    }
  }
  const workspaces = {};
  for (const [key, count] of counts) {
    const [owner, category] = key.split("\0");
    workspaces[owner] ??= {};
    workspaces[owner][category] = count;
  }
  return sortedObject(
    Object.entries(workspaces).map(([owner, categories]) => [
      owner,
      sortedObject(Object.entries(categories)),
    ]),
  );
}

function comparisonRows(current, baseline) {
  const keys = new Set();
  for (const [owner, categories] of Object.entries(current)) {
    for (const category of Object.keys(categories)) keys.add(`${owner}\0${category}`);
  }
  for (const [owner, categories] of Object.entries(baseline)) {
    for (const category of Object.keys(categories)) keys.add(`${owner}\0${category}`);
  }
  return [...keys].sort().map((key) => {
    const [owner, category] = key.split("\0");
    return [owner, category, baseline[owner]?.[category] ?? 0, current[owner]?.[category] ?? 0];
  });
}

function main() {
  const options = parseOptions(process.argv.slice(2), {
    "--root": "root",
    "--baseline": "baseline",
    "--config": "config",
  });
  const baselinePath = options.baseline ?? defaultBaseline;
  const config = options.config ?? `${repositoryRoot}/knip.json`;
  const result = runTool("knip", ["--reporter", "json", "--config", config], options.root);
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Knip did not return JSON: ${result.stderr.trim()}`);
  }
  if (![0, 1].includes(result.status)) {
    throw new Error(`Knip exited ${result.status}: ${result.stderr.trim()}`);
  }
  const current = { workspaces: countsFrom(report) };
  if (options.updateBaseline) writeJson(baselinePath, current);
  const baseline = options.updateBaseline ? current : readJson(baselinePath);
  const rows = comparisonRows(current.workspaces, baseline.workspaces ?? {});
  console.log("Unused code findings");
  printTable(["workspace", "category", "baseline", "now"], rows);
  const failed = rows.some((row) => row[3] > row[2]);
  if (options.updateBaseline) console.log(`Updated ${baselinePath}`);
  console.log(failed ? "unused-code FAIL" : "unused-code PASS");
  process.exitCode = failed ? 1 : 0;
}

try {
  main();
} catch (error) {
  console.error(`unused-code FAIL: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
