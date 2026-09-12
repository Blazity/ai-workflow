/**
 * Workflow definition schema v1 is retired (ADR-003). This gate rejects source
 * that branches on the retired discriminator, reconstructs the retired graph
 * type or walker, or lets production import a test module.
 *
 * Stored history has one narrow exception: stored-definition.ts may read and
 * classify the discriminator. Harness-profile manifests have an unrelated
 * schemaVersion and are exempt only while they contain no workflow-definition
 * reference.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseOptions, printTable } from "./shared.mjs";

const ROOTS = ["apps", "packages", "docs/example-workflows"];
const SCANNED = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"]);
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  ".next",
  ".nitro",
  ".output",
  ".vercel",
  ".turbo",
  "coverage",
]);
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const STORED_DEFINITION_SOURCE =
  "apps/worker/src/engine/definition/stored-definition.ts";
const HARNESS_PROFILE_MANIFESTS = new Set([
  "apps/dashboard/components/cockpit/flow-editor/agent-harness-profile.tsx",
  "apps/dashboard/components/cockpit/harness-profiles/profile-editor.tsx",
  "apps/dashboard/lib/harness-profiles/editor.ts",
  "apps/worker/src/harness-profiles/capability-catalog.ts",
  "apps/worker/src/harness-profiles/manifest.ts",
  "apps/worker/src/db/repositories/harness-profiles.ts",
  "apps/worker/src/sandbox/harness-runtime.ts",
  "packages/contracts/harness-profiles.ts",
]);
const WORKFLOW_REFERENCE =
  /WorkflowDefinition|workflowDefinition|workflow-definition|contracts\/domain|\bdefinition\b|\bdef\b/u;
const TEST_MODULE_SPECIFIER = /\.(?:test|spec)(?:\.(?:ts|tsx|js|mjs|cjs))?$/u;
const IMPORT_PATTERNS = [
  /\b(?:import|export)\s+(?:type\s+)?(?:[^"'`;]*?\s+from\s+)?["']([^"']+)["']/gu,
  /\brequire\s*\(\s*["']([^"']+)["']/gu,
  /\bimport\s*\(\s*["']([^"']+)["']/gu,
];
const IMPORT_DECLARATION =
  /\bimport\s+(?:type\s+)?([^"'`;]+?)\s+from\s+["']([^"']+)["']/gu;
const FORBIDDEN_SYMBOLS = [
  /\bWorkflowDefinitionV1\b/gu,
  /\bisLegacy\b/gu,
  /\bisV2OnlyBlockType\b/gu,
  /\bexecuteGraph\b/gu,
  /\bexecute\w*(?:V1|Legacy|Retired)\w*\b/giu,
];
const SCHEMA_VALUE =
  /(?<![\w])(["']?schemaVersion["']?)\s*:\s*(?:"([^"]*)"|'([^']*)'|(-?(?:0x[\da-f]+|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)))/giu;
const DIRECT_SCHEMA_READS = [
  /\b[A-Za-z_$][\w$]*\s*(?:\?\.|\.)\s*schemaVersion\b/gu,
  /\b[A-Za-z_$][\w$]*\s*(?:\?\.)?\[\s*["']schemaVersion["']\s*\]/gu,
  /\b[\w$]*SchemaVersionOf\s*\([^)]*\)/gu,
];
const DECLARED_SCHEMA_ALIAS =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/gu;
const BRACE_BLOCK = /\{([^{}]*)\}/gsu;
const COMPARISON = "(?:===|!==|==|!=|<=|>=|<|>)";
const VERSION_NUMBER =
  String.raw`(?:["']?(?:1(?:\.0*)?(?:e[+-]?0+)?|0x0*1|2(?:\.0*)?(?:e[+-]?0+)?|0x0*2)["']?)`;

function* sourceFiles(root, directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      yield* sourceFiles(root, path);
      continue;
    }
    if (!entry.isFile()) continue;
    const extension = entry.name.slice(entry.name.lastIndexOf("."));
    if (!SCANNED.has(extension)) continue;
    yield {
      path,
      relativePath: relative(root, path).split(sep).join("/"),
      test: TEST_FILE.test(entry.name),
    };
  }
}

function directoryExists(path) {
  try {
    return statSync(path).isDirectory();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function lineOf(contents, index) {
  return String(contents.slice(0, index).split("\n").length);
}

function addViolation(rows, seen, file, contents, index, match) {
  const key = `${file.relativePath}:${index}:${match}`;
  if (seen.has(key)) return;
  seen.add(key);
  rows.push([file.relativePath, lineOf(contents, index), match]);
}

function collectProductionTestImports(rows, seen, file, contents) {
  if (file.test || file.relativePath.endsWith(".json")) return;
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of contents.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier || !TEST_MODULE_SPECIFIER.test(specifier)) continue;
      addViolation(
        rows,
        seen,
        file,
        contents,
        match.index,
        `production imports test module ${specifier}`,
      );
    }
  }
}

function importSpecifiers(contents) {
  const specifiers = [];
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of contents.matchAll(pattern)) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function isHarnessContractSpecifier(specifier) {
  return (
    specifier === "@shared/contracts/harness-profiles" ||
    /(?:^|\/)packages\/contracts\/harness-profiles(?:\.ts)?$/u.test(specifier)
  );
}

function isLocalOrAliasSpecifier(specifier) {
  return (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("@/") ||
    specifier.startsWith("~/") ||
    specifier.startsWith("#") ||
    specifier === "@shared/contracts" ||
    specifier.startsWith("@shared/")
  );
}

function hasOnlyHarnessContractLocalImports(contents) {
  return importSpecifiers(contents).every(
    (specifier) =>
      !isLocalOrAliasSpecifier(specifier) || isHarnessContractSpecifier(specifier),
  );
}

function localImportCallExpressions(contents) {
  const bindings = new Set();
  IMPORT_DECLARATION.lastIndex = 0;
  for (const match of contents.matchAll(IMPORT_DECLARATION)) {
    const clause = match[1] ?? "";
    const specifier = match[2] ?? "";
    if (!isLocalOrAliasSpecifier(specifier) || isHarnessContractSpecifier(specifier)) {
      continue;
    }
    const named = /\{([^}]*)\}/su.exec(clause)?.[1] ?? "";
    for (const item of named.split(",")) {
      const binding = item.trim().split(/\s+as\s+/u).at(-1)?.trim();
      if (binding && /^[A-Za-z_$][\w$]*$/u.test(binding)) bindings.add(binding);
    }
    const defaultBinding = /^\s*([A-Za-z_$][\w$]*)/u.exec(clause)?.[1];
    if (defaultBinding && defaultBinding !== "type") bindings.add(defaultBinding);
    const namespaceBinding = /\*\s+as\s+([A-Za-z_$][\w$]*)/u.exec(clause)?.[1];
    if (namespaceBinding) bindings.add(namespaceBinding);
  }
  const expressions = [];
  for (const binding of bindings) {
    const call = new RegExp(
      String.raw`\b${binding.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}\s*\([^;\n]*?\)`,
      "gu",
    );
    expressions.push(...contents.matchAll(call).map((match) => match[0]));
  }
  return expressions;
}

function maskHarnessSchemaScope(contents) {
  return contents.replaceAll(/\bschemaVersion\b/gu, "harnessVersion");
}

function schemaReadAliases(contents) {
  const aliases = new Set(["schemaVersion"]);
  for (const pattern of DIRECT_SCHEMA_READS) {
    pattern.lastIndex = 0;
    for (const match of contents.matchAll(pattern)) {
      const before = contents.slice(Math.max(0, match.index - 100), match.index);
      const declaration = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/u.exec(before);
      if (declaration?.[1]) aliases.add(declaration[1]);
    }
  }
  DECLARED_SCHEMA_ALIAS.lastIndex = 0;
  for (const match of contents.matchAll(DECLARED_SCHEMA_ALIAS)) {
    const expression = match[2] ?? "";
    if (
      DIRECT_SCHEMA_READS.some((pattern) => {
        pattern.lastIndex = 0;
        return pattern.test(expression);
      })
    ) {
      aliases.add(match[1]);
    }
  }
  BRACE_BLOCK.lastIndex = 0;
  for (const match of contents.matchAll(BRACE_BLOCK)) {
    const body = match[1] ?? "";
    const alias = /(?:\bschemaVersion\b|\[\s*["']schemaVersion["']\s*\])(?:\s*:\s*([A-Za-z_$][\w$]*))?/u.exec(body);
    if (alias) aliases.add(alias[1] ?? "schemaVersion");
  }
  return aliases;
}

function collectSchemaComparisons(rows, seen, file, contents, extraExpressions = []) {
  const expressions = [];
  for (const pattern of DIRECT_SCHEMA_READS) {
    pattern.lastIndex = 0;
    for (const match of contents.matchAll(pattern)) expressions.push(match[0]);
  }
  expressions.push(...schemaReadAliases(contents), ...extraExpressions);
  for (const expression of new Set(expressions)) {
    const escaped = expression.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const source = /^[A-Za-z_$][\w$]*$/u.test(expression)
      ? String.raw`\b${escaped}\b`
      : escaped;
    const pattern = new RegExp(
      String.raw`(?:${source}\s*${COMPARISON}\s*${VERSION_NUMBER}|${VERSION_NUMBER}\s*${COMPARISON}\s*${source})`,
      "giu",
    );
    for (const match of contents.matchAll(pattern)) {
      addViolation(rows, seen, file, contents, match.index, match[0]);
    }
  }
}

function collectSourceViolations(rows, seen, file, contents, extraExpressions = []) {
  for (const pattern of FORBIDDEN_SYMBOLS) {
    pattern.lastIndex = 0;
    for (const match of contents.matchAll(pattern)) {
      addViolation(rows, seen, file, contents, match.index, match[0]);
    }
  }
  SCHEMA_VALUE.lastIndex = 0;
  for (const match of contents.matchAll(SCHEMA_VALUE)) {
    const stringValue = match[2] ?? match[3];
    const numericValue = match[4];
    if (stringValue !== undefined || Number(numericValue) !== 2) {
      addViolation(rows, seen, file, contents, match.index, match[0]);
    }
  }
  if (file.relativePath !== STORED_DEFINITION_SOURCE) {
    collectSchemaComparisons(rows, seen, file, contents, extraExpressions);
  }
}

function collectJsonSchemaVersions(value, path = "$") {
  const violations = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      violations.push(...collectJsonSchemaVersions(item, `${path}[${index}]`));
    });
    return violations;
  }
  if (!value || typeof value !== "object") return violations;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (key === "schemaVersion" && (typeof child !== "number" || child !== 2)) {
      violations.push([childPath, JSON.stringify(child)]);
    }
    violations.push(...collectJsonSchemaVersions(child, childPath));
  }
  return violations;
}

function main() {
  const options = parseOptions(process.argv.slice(2), { "--root": "root" });
  const rows = [];
  const seen = new Set();
  for (const root of ROOTS) {
    const directory = join(options.root, root);
    if (!directoryExists(directory)) continue;
    for (const file of sourceFiles(options.root, directory)) {
      const contents = readFileSync(file.path, "utf8");
      collectProductionTestImports(rows, seen, file, contents);
      if (file.test) continue;
      const harnessProfileManifest = HARNESS_PROFILE_MANIFESTS.has(file.relativePath);
      const harnessProfileExempt =
        harnessProfileManifest &&
        !WORKFLOW_REFERENCE.test(contents) &&
        hasOnlyHarnessContractLocalImports(contents);
      if (harnessProfileExempt) {
        continue;
      }
      if (file.relativePath.endsWith(".json")) {
        try {
          const parsed = JSON.parse(contents);
          for (const [jsonPath, value] of collectJsonSchemaVersions(parsed)) {
            rows.push([file.relativePath, jsonPath, `schemaVersion: ${value}`]);
          }
          continue;
        } catch {
          // JSON-with-comments falls through to the whole-source scanner.
        }
      }
      const scopedContents =
        harnessProfileManifest && !WORKFLOW_REFERENCE.test(contents)
          ? maskHarnessSchemaScope(contents)
          : contents;
      collectSourceViolations(
        rows,
        seen,
        file,
        scopedContents,
        harnessProfileManifest ? localImportCallExpressions(contents) : [],
      );
    }
  }
  console.log("Definition schema version branches");
  if (rows.length > 0) printTable(["file", "line", "match"], rows);
  else console.log("none");
  console.log(rows.length > 0 ? "single-schema-version FAIL" : "single-schema-version PASS");
  process.exitCode = rows.length > 0 ? 1 : 0;
}

try {
  main();
} catch (error) {
  console.error(
    `single-schema-version FAIL: ${error instanceof Error ? error.message : error}`,
  );
  process.exitCode = 1;
}
