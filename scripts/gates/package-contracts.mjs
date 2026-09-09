/**
 * This gate makes every shared workspace state its architecture contract. It
 * exits 1 when a package.json directly under packages or apps/shared has no
 * non-empty description. Add or revise the description with the package change.
 */
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { parseOptions, printTable, readJson } from "./shared.mjs";

function packageFiles(root) {
  return ["packages", "apps/shared"].flatMap((parent) => {
    const directory = join(root, parent);
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(directory, entry.name, "package.json")))
      .map((entry) => join(directory, entry.name, "package.json"));
  });
}

function main() {
  const options = parseOptions(process.argv.slice(2), { "--root": "root" });
  const rows = packageFiles(options.root).sort().map((file) => {
    const description = readJson(file).description;
    return [relative(options.root, file), typeof description === "string" && description.trim() ? "present" : "missing"];
  });
  console.log("Package contracts");
  printTable(["package", "description"], rows);
  const failed = rows.some((row) => row[1] === "missing");
  console.log(failed ? "package-contracts FAIL" : "package-contracts PASS");
  process.exitCode = failed ? 1 : 0;
}

try {
  main();
} catch (error) {
  console.error(`package-contracts FAIL: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
