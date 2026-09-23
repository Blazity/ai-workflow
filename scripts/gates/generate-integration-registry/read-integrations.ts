import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import {
  objectProperty,
  sourceFile,
  stringValue,
  unwrap,
} from "../generate-block-catalog/manifest-ast.js";
import { readManifests } from "../generate-block-catalog/read-manifests.js";
import { compareCodePoints } from "../generate-block-catalog/types.js";
import {
  assertDashboardUsesBrowserGlobals,
  assertManifestIsPureData,
} from "./manifest-imports.js";
import { INTEGRATION_BLOCK_TYPE, INTEGRATION_ID } from "../../../packages/contracts/integration-id.js";
import { integrationBlockPortsIssue } from "../../../integrations/sdk/block-ports.js";
import {
  FIXTURES_DIRECTORY,
  NON_INTEGRATION_DIRECTORIES,
  type GeneratorOptions,
  type IntegrationRecord,
} from "./types.js";

function integrationsRoot(options: GeneratorOptions): string {
  return options.integrationsRoot ?? join(options.root, "integrations");
}

/** Repository-relative and with forward slashes, which is what messages print. */
function localPath(root: string, absolute: string): string {
  return relative(root, absolute).replaceAll("\\", "/");
}

type Declarations = Map<string, ts.Expression>;

function exportedAndLocalDeclarations(file: ts.SourceFile): Declarations {
  const declarations: Declarations = new Map();
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        declarations.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return declarations;
}

/** Where a named import came from, so a block declared in its own file is still read. */
function importedFrom(file: ts.SourceFile, name: string): string | null {
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.name.text === name) return statement.moduleSpecifier.text;
    }
  }
  return null;
}

function resolveLocalFile(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier.replace(/\.js$/u, ""));
  for (const extension of [".ts", ".tsx", "/index.ts", "/index.tsx", ""]) {
    const candidate = base + extension;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * A block is written either inline in the manifest or as its own
 * `defineIntegrationBlock` export, which is what the SDK invites, so following
 * the identifier one file out is the difference between reading every block
 * type and reading the ones that happened to be inline.
 */
function blockObject(
  expression: ts.Expression,
  filePath: string,
  manifestPath: string,
): ts.ObjectLiteralExpression {
  const value = unwrap(expression);
  if (ts.isObjectLiteralExpression(value)) return value;
  if (ts.isCallExpression(value) && value.arguments.length > 0) {
    return blockObject(value.arguments[0]!, filePath, manifestPath);
  }
  if (ts.isIdentifier(value)) {
    const file = sourceFile(filePath);
    const local = exportedAndLocalDeclarations(file).get(value.text);
    if (local) return blockObject(local, filePath, manifestPath);
    const specifier = importedFrom(file, value.text);
    const target = specifier?.startsWith(".") ? resolveLocalFile(filePath, specifier) : null;
    if (target) return blockObject(value, target, manifestPath);
  }
  throw new Error(
    `${manifestPath}: cannot read a block declaration. Declare each block with defineIntegrationBlock, ` +
      "either in the manifest file or in a file of its own inside the package.",
  );
}

function blockPorts(
  block: ts.ObjectLiteralExpression,
  printed: string,
): string[] {
  const contract = objectProperty(block, "contract");
  const value = contract && unwrap(contract);
  if (!value || !ts.isObjectLiteralExpression(value)) {
    throw new Error(`${printed}: every block needs a contract object literal.`);
  }
  const ports = objectProperty(value, "ports");
  const list = ports && unwrap(ports);
  if (!list || !ts.isArrayLiteralExpression(list)) {
    throw new Error(`${printed}: blocks[].contract.ports must be an array literal.`);
  }
  return list.elements.map((element, index) =>
    stringValue(element, printed, `blocks[].contract.ports[${index}]`),
  );
}

function blockTypes(
  manifest: ts.ObjectLiteralExpression,
  manifestPath: string,
  printed: string,
  id: string,
): string[] {
  const blocks = objectProperty(manifest, "blocks");
  const value = blocks && unwrap(blocks);
  if (!value || !ts.isArrayLiteralExpression(value)) {
    throw new Error(`${printed}: manifest.blocks must be an array literal.`);
  }
  return value.elements.map((element) => {
    const object = blockObject(element, manifestPath, printed);
    const type = stringValue(objectProperty(object, "type"), printed, "blocks[].type");
    if (!type.startsWith(`${id}_`)) {
      throw new Error(
        `${printed}: the block type "${type}" must start with "${id}_", so a stored definition says which integration a block belongs to.`,
      );
    }
    // The whole stored block type, not only its prefix: the rule a definition
    // carrying the type is parsed with, so a manifest that generates cleanly
    // and is then unstorable is refused here, where the mistake is.
    if (!INTEGRATION_BLOCK_TYPE.test(type)) {
      throw new Error(
        `${printed}: the block type "${type}" must be lowercase words joined by underscores. ` +
          "A definition carrying any other shape cannot be parsed, so it would generate here and fail at the editor.",
      );
    }
    const portsIssue = integrationBlockPortsIssue(type, blockPorts(object, printed));
    if (portsIssue !== null) throw new Error(`${printed}: ${portsIssue}`);
    return type;
  });
}

/** `pages[].id`, in declaration order, so the registry and the tab strip agree. */
function pageIds(
  manifest: ts.ObjectLiteralExpression,
  printed: string,
): string[] {
  const pages = objectProperty(manifest, "pages");
  const value = pages && unwrap(pages);
  if (!value || !ts.isArrayLiteralExpression(value)) {
    throw new Error(`${printed}: manifest.pages must be an array literal.`);
  }
  return value.elements.map((element, index) => {
    const object = unwrap(element);
    if (!ts.isObjectLiteralExpression(object)) {
      throw new Error(`${printed}: pages[${index}] must be an object literal.`);
    }
    return stringValue(objectProperty(object, "id"), printed, `pages[${index}].id`);
  });
}

function readManifest(
  root: string,
  directory: string,
  fixture: boolean,
): IntegrationRecord {
  const printed = localPath(root, directory);
  const manifestPath = join(directory, "manifest.ts");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `${printed}: every integration needs manifest.ts exporting a manifest declared with defineIntegration. ` +
        "A directory under integrations/ that is not an integration is refused rather than skipped, so a half-written one cannot vanish from the registry.",
    );
  }
  const workerPath = join(directory, "worker.ts");
  if (!existsSync(workerPath)) {
    throw new Error(
      `${printed}: every integration needs worker.ts exporting a runtime declared with defineIntegrationRuntime. ` +
        "Without it nothing can test the connection, serve a capability or run a block.",
    );
  }
  if (!existsSync(join(directory, "README.md"))) {
    throw new Error(
      `${printed}: every integration needs README.md. It is the first thing the next person reads, ` +
        "and the guide points at it.",
    );
  }
  assertManifestIsPureData(directory, manifestPath, root);

  const file = sourceFile(manifestPath);
  const declaration = exportedAndLocalDeclarations(file).get("manifest");
  if (!declaration) throw new Error(`${printed}/manifest.ts: export a const named manifest.`);
  const call = unwrap(declaration);
  const object =
    ts.isCallExpression(call) && call.arguments.length > 0
      ? unwrap(call.arguments[0]!)
      : call;
  if (!ts.isObjectLiteralExpression(object)) {
    throw new Error(
      `${printed}/manifest.ts: the manifest must be declared with defineIntegration({ ... }).`,
    );
  }

  const id = stringValue(objectProperty(object, "id"), `${printed}/manifest.ts`, "id");
  if (!INTEGRATION_ID.test(id)) {
    throw new Error(
      `${printed}/manifest.ts: the integration id "${id}" must be 3 to 32 lowercase letters and digits starting with a letter.`,
    );
  }
  const packageFile = join(directory, "package.json");
  if (!existsSync(packageFile)) throw new Error(`${printed}: every integration needs package.json.`);
  const packageName = (JSON.parse(readFileSync(packageFile, "utf8")) as { name?: string }).name;
  if (packageName !== `@integrations/${id}`) {
    throw new Error(
      `${printed}/package.json: the package is named "${String(packageName)}" while its manifest id is "${id}". ` +
        `Name it "@integrations/${id}" so one name reaches the package, the webhook URL and the screen.`,
    );
  }

  // The dashboard entry is required exactly when the manifest declares a page
  // and refused otherwise. A declared page with no component is a tab that
  // renders nothing, and a component nobody declared is code that never runs;
  // both are cheaper to meet here than in the cockpit.
  const pages = pageIds(object, `${printed}/manifest.ts`);
  const dashboardPath = join(directory, "dashboard.tsx");
  const hasDashboard = existsSync(dashboardPath);
  if (pages.length > 0 && !hasDashboard) {
    throw new Error(
      `${printed}: the manifest declares the page${pages.length === 1 ? "" : "s"} ${pages
        .map((page) => JSON.stringify(page))
        .join(", ")}, so the package needs dashboard.tsx exporting a const named dashboard, ` +
        "declared with defineIntegrationDashboard from @integrations/host-ui. Without it the tab is in the sidebar and renders nothing.",
    );
  }
  if (pages.length === 0 && hasDashboard) {
    throw new Error(
      `${printed}/dashboard.tsx: the manifest declares no pages, so nothing in the cockpit can reach this file. ` +
        "Declare the pages in manifest.pages, or delete the entry.",
    );
  }
  if (hasDashboard) assertDashboardUsesBrowserGlobals(directory, dashboardPath, root);

  return {
    directory: localPath(root, directory),
    id,
    packageName,
    blockTypes: blockTypes(object, manifestPath, `${printed}/manifest.ts`, id),
    fixture,
    manifestPath: localPath(root, manifestPath),
    workerPath: localPath(root, workerPath),
    pageIds: pages,
    dashboardPath: hasDashboard ? localPath(root, dashboardPath) : null,
  };
}

function candidateDirectories(root: string): Array<{ directory: string; fixture: boolean }> {
  const found: Array<{ directory: string; fixture: boolean }> = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if ((NON_INTEGRATION_DIRECTORIES as readonly string[]).includes(entry.name)) continue;
    if (entry.name === FIXTURES_DIRECTORY) {
      for (const fixture of readdirSync(join(root, entry.name), { withFileTypes: true })) {
        if (fixture.isDirectory()) {
          found.push({ directory: join(root, entry.name, fixture.name), fixture: true });
        }
      }
      continue;
    }
    // Every other underscore directory is scaffolding: read for its own gates,
    // never registered. `_template` is the one today.
    if (entry.name.startsWith("_")) continue;
    found.push({ directory: join(root, entry.name), fixture: false });
  }
  return found;
}

/**
 * Every integration this build ships, in id order. Fixtures are read and
 * checked whatever the flag says; `includeFixtures` decides only whether they
 * reach the registries.
 */
export function readIntegrations(options: GeneratorOptions): IntegrationRecord[] {
  const root = integrationsRoot(options);
  if (!existsSync(root)) throw new Error(`The integrations directory does not exist: ${root}`);

  const records = candidateDirectories(root)
    .map(({ directory, fixture }) => readManifest(options.root, directory, fixture))
    .toSorted((left, right) => compareCodePoints(left.id, right.id));

  const ids = new Map<string, string>();
  for (const record of records) {
    const clash = ids.get(record.id);
    if (clash) {
      throw new Error(`Two integrations claim the id "${record.id}": ${clash} and ${record.directory}.`);
    }
    ids.set(record.id, record.directory);
  }

  const owners = new Map<string, string>();
  for (const core of readManifests({ root: options.root, blocksRoot: options.blocksRoot })) {
    owners.set(core.type, "a core block");
  }
  for (const record of records) {
    for (const type of record.blockTypes) {
      if (!type.startsWith(`${record.id}_`)) {
        throw new Error(
          `${record.directory}: the block type "${type}" must start with "${record.id}_", so a definition names its integration.`,
        );
      }
      const owner = owners.get(type);
      if (owner) {
        throw new Error(
          `${record.directory}: the block type "${type}" is already taken by ${owner}. ` +
            "A block type is what a stored workflow definition holds, so two blocks cannot share one. " +
            "Rename the integration block, or land the stage that deletes the core block first.",
        );
      }
      owners.set(type, record.directory);
    }
  }

  return records.filter((record) => options.includeFixtures === true || !record.fixture);
}
