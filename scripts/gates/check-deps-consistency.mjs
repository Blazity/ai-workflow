/**
 * This gate keeps one version of every dependency more than one workspace
 * project declares. It exits 1 when such a dependency is not on `catalog:`, or
 * when two projects pin it to different specifiers. There is no baseline: put
 * the dependency in the `catalog` block of pnpm-workspace.yaml and set every
 * consumer to `catalog:`. Workspace links (`workspace:*`) are not versions and
 * are ignored, and all four dependency fields count, so a shared peer or
 * optional dependency obeys the catalog like any other. The workspace root
 * counts as a project because its devDependencies land in the same
 * node_modules tree as every app's.
 *
 * The helpers below are declared in one sorted declaration, so each is named to
 * keep alphabetical order and call order the same.
 */
import { existsSync, globSync, readFileSync, statSync } from "node:fs";
import { parseOptions, printTable, readJson } from "./shared.mjs";
import path from "node:path";
import process from "node:process";

const ARGV_START = 2,
  CATALOG_ENTRY_PATTERN = /^\s+["']?(?<name>@?[^"':\s]+)["']?\s*:/u,
  CATALOG_HEADING = /^catalog:\s*$/mu,
  CATALOG_OR_CATALOGS_HEADING = /^catalogs?:/mu,
  CATALOG_SPECIFIER = "catalog:",
  DEPENDENCY_FIELDS = [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ],
  FAILURE_CODE = 1,
  FIRST_BLOCK = 0,
  GLOB_PATTERN = /^\s*-\s*["']?(?<entry>[^"'#\n]+?)["']?\s*$/gmu,
  MINIMUM_SHARED_PROJECTS = 2,
  OUTDENTED_PATTERN = /^\S/u,
  SINGLE_SPECIFIER = 1,
  SUCCESS_CODE = 0,
  VERDICT_COLUMN = 3,
  WORKSPACE_ROOT = ".",
  // Records one use, ignoring workspace links, which are not versions.
  addDeclaration = (declarations, name, use) => {
    if (typeof use.specifier === "string" && !use.specifier.startsWith("workspace:")) {
      if (!declarations.has(name)) {
        declarations.set(name, []);
      }
      declarations.get(name).push(use);
    }
  },
  // Compares two [name, uses] entries by dependency name.
  alphabetically = ([left], [right]) => left.localeCompare(right),
  // Applies one workspace glob, adding or removing the directories it matches.
  applyGlob = (directories, root, pattern) => {
    let excluded = false,
      glob = pattern;
    if (pattern.startsWith("!")) {
      excluded = true;
      glob = pattern.slice(SINGLE_SPECIFIER);
    }
    for (const directory of globSync(glob, { cwd: root })) {
      if (excluded) {
        directories.delete(directory);
      } else {
        directories.add(directory);
      }
    }
  },
  // Classifies one shared dependency against the catalog.
  assessDependency = (catalog, name, specifiers) => {
    if (specifiers.length > SINGLE_SPECIFIER) {
      return "split";
    }
    if (!specifiers.every((specifier) => specifier === CATALOG_SPECIFIER)) {
      return "not-cataloged";
    }
    if (!catalog.has(name)) {
      return "missing-from-catalog";
    }
    return "ok";
  },
  // One row per dependency that more than one project declares.
  buildRows = (catalog, declarations) => {
    const rows = [];
    for (const [name, uses] of [...declarations].toSorted(alphabetically)) {
      if (uses.length >= MINIMUM_SHARED_PROJECTS) {
        const specifiers = [...new Set(uses.map((use) => use.specifier))];
        rows.push([
          name,
          String(uses.length),
          specifiers.join(" | "),
          assessDependency(catalog, name, specifiers),
        ]);
      }
    }
    return rows;
  },
  // Reads pnpm-workspace.yaml, failing with a clear message when it is absent.
  getWorkspaceFile = (root) => {
    const workspaceFile = path.join(root, "pnpm-workspace.yaml");
    if (!existsSync(workspaceFile)) {
      throw new Error("pnpm-workspace.yaml is missing.");
    }
    return readFileSync(workspaceFile, "utf8");
  },
  // True when the workspace directory actually holds a package.json.
  isProject = (root, directory) =>
    existsSync(path.join(root, directory, "package.json")) &&
    statSync(path.join(root, directory)).isDirectory(),
  // Every directory the `packages` globs resolve to, plus the workspace root.
  listProjects = (root) => {
    const directories = new Set([WORKSPACE_ROOT]),
      packagesBlock = getWorkspaceFile(root).split(CATALOG_OR_CATALOGS_HEADING).at(FIRST_BLOCK);
    for (const match of packagesBlock.matchAll(GLOB_PATTERN)) {
      applyGlob(directories, root, match.groups.entry);
    }
    return [...directories].filter((directory) => isProject(root, directory)).toSorted();
  },
  // Dependency names listed under the `catalog:` block.
  loadCatalog = (root) => {
    const [, block] = getWorkspaceFile(root).split(CATALOG_HEADING),
      names = new Set();
    if (!block) {
      return names;
    }
    for (const line of block.split("\n")) {
      if (OUTDENTED_PATTERN.test(line) && line.trim()) {
        break;
      }
      const match = line.match(CATALOG_ENTRY_PATTERN);
      if (match) {
        names.add(match.groups.name);
      }
    }
    return names;
  },
  // Maps every declared dependency name to the projects that declare it.
  loadDeclarations = (root, projects) => {
    const declarations = new Map();
    for (const project of projects) {
      const manifest = readJson(path.join(root, project, "package.json"));
      for (const field of DEPENDENCY_FIELDS) {
        for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
          addDeclaration(declarations, name, { project, specifier });
        }
      }
    }
    return declarations;
  },
  main = () => {
    const options = parseOptions(process.argv.slice(ARGV_START), { "--root": "root" }),
      rows = buildRows(loadCatalog(options.root), loadDeclarations(options.root, listProjects(options.root))),
      violations = rows.some((row) => row[VERDICT_COLUMN] !== "ok");
    process.stdout.write("Shared dependency versions\n");
    printTable(["dependency", "projects", "specifiers", "verdict"], rows);
    if (violations) {
      process.stdout.write("check-deps-consistency FAIL\n");
      process.exitCode = FAILURE_CODE;
    } else {
      process.stdout.write("check-deps-consistency PASS\n");
      process.exitCode = SUCCESS_CODE;
    }
  };

try {
  main();
} catch (error) {
  let detail = error;
  if (error instanceof Error) {
    detail = error.message;
  }
  process.stderr.write(`check-deps-consistency FAIL: ${detail}\n`);
  process.exitCode = FAILURE_CODE;
}
