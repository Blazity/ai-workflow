import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";
import {
  booleanValue,
  exportedVariable,
  objectProperty,
  objectValue,
  sourceFile,
  stringArrayValue,
  stringValue,
  uiValue,
  unwrap,
} from "./manifest-ast.js";
import { assertPureImports } from "./manifest-imports.js";
import { localDeclarations, requiredStaticValue } from "./static-value.js";
import {
  compareCodePoints,
  type BlockCategory,
  type GeneratorOptions,
  type ManifestRecord,
} from "./types.js";

function manifestRoot(options: GeneratorOptions): string {
  return options.blocksRoot ?? join(options.root, "apps/worker/src/engine/blocks");
}

function parseContract(
  manifest: ts.ObjectLiteralExpression,
  manifestPath: string,
): Pick<ManifestRecord, "category" | "ports" | "allowsFailurePort"> {
  const contract = objectValue(objectProperty(manifest, "contract"), manifestPath, "contract");
  const category = stringValue(
    objectProperty(contract, "category"),
    manifestPath,
    "contract.category",
  );
  if (category !== "trigger" && category !== "action" && category !== "control") {
    throw new Error(manifestPath + ": manifest.contract.category is invalid.");
  }
  return {
    category: category as BlockCategory,
    ports: stringArrayValue(
      objectProperty(contract, "ports"),
      manifestPath,
      "contract.ports",
    ),
    allowsFailurePort: booleanValue(
      objectProperty(contract, "allowsFailurePort"),
      manifestPath,
      "contract.allowsFailurePort",
    ),
  };
}

function parseExecution(manifest: ts.ObjectLiteralExpression, manifestPath: string): ManifestRecord["execution"] {
  const execution = stringValue(
    objectProperty(manifest, "execution"),
    manifestPath,
    "execution",
  );
  if (execution !== "map" && execution !== "inline" && execution !== "graph") {
    throw new Error(manifestPath + ": manifest.execution is invalid.");
  }
  return execution;
}

function parseManifest(manifestPath: string, directory: string): ManifestRecord {
  const file = sourceFile(manifestPath);
  assertPureImports(manifestPath, file);
  const declaration = exportedVariable(file, "manifest");
  if (!declaration?.initializer) throw new Error(manifestPath + ": export a manifest object.");
  const manifest = unwrap(declaration.initializer);
  if (!ts.isObjectLiteralExpression(manifest)) {
    throw new Error(manifestPath + ": exported manifest must be an object literal.");
  }

  const declarations = localDeclarations(file);
  const contract = parseContract(manifest, manifestPath);
  const execution = parseExecution(manifest, manifestPath);
  if (!objectProperty(manifest, "paramsSchema")) {
    throw new Error(manifestPath + ": manifest.paramsSchema is required.");
  }
  return {
    directory,
    manifestPath,
    type: stringValue(objectProperty(manifest, "type"), manifestPath, "type"),
    ...contract,
    ui: uiValue(objectProperty(manifest, "ui"), manifestPath),
    defaults: requiredStaticValue(manifest, "defaults", manifestPath, declarations),
    inputs: requiredStaticValue(manifest, "inputs", manifestPath, declarations),
    additionalInputs: objectProperty(manifest, "additionalInputs")
      ? requiredStaticValue(manifest, "additionalInputs", manifestPath, declarations)
      : [],
    execution,
    hasExecute: existsSync(join(dirname(manifestPath), "execute.ts")),
  };
}

export function readManifests(options: GeneratorOptions): ManifestRecord[] {
  const root = manifestRoot(options);
  if (!existsSync(root)) throw new Error("Block manifest directory does not exist: " + root);
  const records = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "support")
    .map((entry) => {
      const manifestPath = join(root, entry.name, "manifest.ts");
      if (!existsSync(manifestPath)) {
        throw new Error(manifestPath + ": every block directory needs manifest.ts.");
      }
      return parseManifest(manifestPath, entry.name);
    })
    .toSorted((left, right) => compareCodePoints(left.type, right.type));

  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.type)) throw new Error("Duplicate block manifest type: " + record.type + ".");
    seen.add(record.type);
    if (record.execution === "map" && !record.hasExecute) {
      throw new Error(record.manifestPath + ": map execution requires execute.ts.");
    }
  }
  if (records.length === 0) throw new Error("No block manifests found in " + root + ".");
  return records;
}
