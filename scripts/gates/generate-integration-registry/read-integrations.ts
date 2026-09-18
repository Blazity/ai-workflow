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
import { assertManifestIsPureData } from "./manifest-imports.js";
import {
  FIXTURES_DIRECTORY,
  INTEGRATION_ID,
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

function blockTypes(
  manifest: ts.ObjectLiteralExpression,
  manifestPath: string,
  printed: string,
): string[] {
  const blocks = objectProperty(manifest, "blocks");
  const value = blocks && unwrap(blocks);
  if (!value || !ts.isArrayLiteralExpression(value)) {
    throw new Error(`${printed}: manifest.blocks must be an array literal.`);
  }
  return value.elements.map((element) => {
    const object = blockObject(element, manifestPath, printed);
    return stringValue(objectProperty(object, "type"), printed, "blocks[].type");
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

  return {
    directory: localPath(root, directory),
    id,
    packageName,
    blockTypes: blockTypes(object, manifestPath, `${printed}/manifest.ts`),
    fixture,
    manifestPath: localPath(root, manifestPath),
    workerPath: localPath(root, workerPath),
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
