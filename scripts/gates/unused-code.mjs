/**
 * This gate runs Knip as a hard check. Any unused file, dependency, export,
 * or type fails the gate, and every finding is printed for repair.
 * knip.json ignores generated files, build output, generated MCP data, sandbox
 * agent fixtures, and WDK fixtures because those paths are generated, vendored,
 * or discovered by runtimes that Knip cannot model.
 */
import {
  parseOptions,
  printTable,
  repositoryRoot,
  runTool,
  sortedObject,
} from "./shared.mjs";

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
      if (!Array.isArray(findings) || findings.length === 0) continue;
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

function findingLines(report) {
  return (report.issues ?? []).flatMap((issue) =>
    Object.entries(issue).flatMap(([category, findings]) => {
      if (!Array.isArray(findings)) return [];
      return findings.map(
        (finding) => `${issue.file ?? "<unknown>"} ${category} ${JSON.stringify(finding)}`,
      );
    }),
  );
}

function main() {
  const options = parseOptions(process.argv.slice(2), {
    "--root": "root",
    "--config": "config",
  });
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
  const workspaces = countsFrom(report);
  const rows = Object.entries(workspaces).flatMap(([owner, categories]) =>
    Object.entries(categories).map(([category, count]) => [owner, category, count]),
  );
  console.log("Unused code findings");
  printTable(["workspace", "category", "count"], rows);
  const failed = rows.length > 0;
  if (failed) {
    console.log("Unused code diagnostics");
    for (const finding of findingLines(report)) console.log(finding);
  }
  console.log(failed ? "unused-code FAIL" : "unused-code PASS");
  process.exitCode = failed ? 1 : 0;
}

try {
  main();
} catch (error) {
  console.error(`unused-code FAIL: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
