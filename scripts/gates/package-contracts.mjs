/**
 * This gate makes every shared workspace state its architecture contract. It
 * exits 1 when a package.json directly under packages has no non-empty
 * description. Add or revise the description with the package change.
 */
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { parseOptions, printTable, readJson, requireAnchor, requireScan } from "./shared.mjs";

// integrations/ holds workspace packages too, and an integration's description
// is what the person deciding whether to connect it reads, so it is a contract
// twice over. Fixtures sit one level deeper, under integrations/_fixtures.
const PACKAGE_ROOTS = ["packages", "integrations"];
// Fixtures are a nested root, and a build that carries none is a build with
// nothing to check there rather than a missing anchor.
const OPTIONAL_PACKAGE_ROOTS = ["integrations/_fixtures"];
const INVARIANT = "the rule that every shared workspace states its architecture contract";

function packageFiles(root) {
  const roots = [
    ...PACKAGE_ROOTS,
    ...OPTIONAL_PACKAGE_ROOTS.filter((parent) => existsSync(join(root, parent))),
  ];
  return roots.flatMap((parent) => {
    const directory = join(root, parent);
    requireAnchor(root, parent, "a package root this gate scans", INVARIANT);
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
  requireScan(rows.length, "workspace package manifests", PACKAGE_ROOTS.join(", "), INVARIANT);
  console.log("Package contracts");
  printTable(["package", "description"], rows);
  const failed = rows.some((row) => row[1] === "missing");
  console.log(failed ? "package-contracts FAIL" : `package-contracts PASS: ${rows.length} package(s) checked`);
  process.exitCode = failed ? 1 : 0;
}

try {
  main();
} catch (error) {
  console.error(`package-contracts FAIL: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
