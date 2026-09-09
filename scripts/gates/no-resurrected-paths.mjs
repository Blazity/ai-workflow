/**
 * This gate prevents completed moves from being undone by a later rebase. It
 * exits 1 when any path in no-resurrected-paths.json exists. Update the list
 * by appending paths removed by an approved architecture stage.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOptions, printTable, readJson } from "./shared.mjs";

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
  const rows = paths.map((path) => [path, existsSync(join(options.root, path)) ? "exists" : "absent"]);
  console.log("Retired paths");
  printTable(["path", "state"], rows);
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
