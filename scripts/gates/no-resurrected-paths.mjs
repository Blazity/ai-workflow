/**
 * This gate prevents completed moves from being undone by a later rebase. It
 * exits 1 when any path in no-resurrected-paths.json has a tracked or
 * non-ignored file. Update the list by appending paths removed by an approved
 * architecture stage.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOptions, printTable, readJson } from "./shared.mjs";

function repositoryFiles(root) {
  const result = spawnSync(
    "/usr/bin/git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0) return null;
  return new Set(result.stdout.split(/\r?\n/u).filter(Boolean));
}

function pathState(root, retiredPath, files) {
  if (files === null) {
    return existsSync(join(root, retiredPath)) ? "exists" : "absent";
  }
  const hasActiveFile = [...files].some(
    (file) => file === retiredPath || file.startsWith(`${retiredPath}/`),
  );
  if (hasActiveFile) return "exists";
  return existsSync(join(root, retiredPath)) ? "ignored residue" : "absent";
}

function main() {
  const options = parseOptions(process.argv.slice(2), {
    "--root": "root",
    "--list": "list",
  });
  const listPath = options.list ?? fileURLToPath(new URL("./no-resurrected-paths.json", import.meta.url));
  const paths = readJson(listPath);
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string" || !path)) {
    throw new Error("The resurrected path baseline must be a list of non-empty strings.");
  }
  const files = repositoryFiles(options.root);
  const rows = paths.map((path) => [path, pathState(options.root, path, files)]);
  console.log("Retired paths");
  printTable(["path", "state"], rows);
  for (const [path, state] of rows) {
    if (state === "ignored residue") {
      console.log(`${path}: ignored residue only; delete directory ${path}`);
    }
  }
  const failed = rows.some((row) => row[1] === "exists");
  console.log(failed ? "no-resurrected-paths FAIL" : "no-resurrected-paths PASS");
  process.exitCode = failed ? 1 : 0;
}

try {
  main();
} catch (error) {
  console.error(`no-resurrected-paths FAIL: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
