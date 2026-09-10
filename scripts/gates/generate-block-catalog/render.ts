import { dirname, join, relative } from "node:path";
import {
  DEFAULT_OUTPUT_PATHS,
  GENERATED_HEADER,
  type GeneratedFiles,
  type GeneratorOptions,
  type ManifestRecord,
  type StaticValue,
} from "./types.js";
import { readManifests } from "./read-manifests.js";

function outputPaths(options: GeneratorOptions): Record<keyof GeneratedFiles, string> {
  return {
    catalog: options.outputPaths?.catalog ?? join(options.root, DEFAULT_OUTPUT_PATHS.catalog),
    params: options.outputPaths?.params ?? join(options.root, DEFAULT_OUTPUT_PATHS.params),
    executors:
      options.outputPaths?.executors ?? join(options.root, DEFAULT_OUTPUT_PATHS.executors),
  };
}

function importPath(fromFile: string, targetFile: string): string {
  const path = relative(dirname(fromFile), targetFile).replaceAll("\\", "/");
  return path.startsWith(".") ? path : "./" + path;
}

function camelCase(value: string): string {
  return value.replaceAll(
    /[-_]+([A-Za-z0-9])/gu,
    (_match, character: string) => character.toUpperCase(),
  );
}

function json(value: StaticValue): string {
  return JSON.stringify(value);
}

function prettyProperty(
  name: string,
  value: StaticValue,
  indent: string,
  comma = true,
): string[] {
  const lines = JSON.stringify(value, null, 2)!.split("\n");
  const rendered = lines.map((line) => indent + line);
  rendered[0] = indent + name + ": " + lines[0];
  if (comma) rendered[rendered.length - 1] += ",";
  return rendered;
}

function renderCatalogEntry(record: ManifestRecord): string[] {
  return [
    "  " + record.type + ": {",
    "    contract: " +
      json({
        category: record.category,
        ports: record.ports,
        allowsFailurePort: record.allowsFailurePort,
      }) +
      ",",
    "    ui: " + json(record.ui) + ",",
    ...prettyProperty("defaults", record.defaults, "    "),
    ...prettyProperty("inputs", record.inputs, "    "),
    ...prettyProperty("additionalInputs", record.additionalInputs, "    "),
    "    execution: " + JSON.stringify(record.execution) + ",",
    "  },",
  ];
}

function catalogHeader(): string[] {
  return [
    GENERATED_HEADER.trimEnd(),
    "",
    "import type {",
    "  WorkflowBlockAdditionalInputContract,",
    "  WorkflowBlockGroup,",
    "  WorkflowBlockInputContract,",
    "  WorkflowParamValue,",
    "} from \"./block-catalog-types\";",
    "",
    'export type BlockCategory = "trigger" | "action" | "control";',
    "",
    "export interface BlockTypeSpec {",
    "  category: BlockCategory;",
    "  ports: string[];",
    "  allowsFailurePort: boolean;",
    "}",
    "",
    'export type BlockExecutionKind = "map" | "inline" | "graph";',
    "",
    "export interface BlockUiHints {",
    "  group: WorkflowBlockGroup;",
    "  label: string;",
    "  description: string;",
    "  glyph: string;",
    "  color: string;",
    "  softColor: string;",
    "}",
    "",
    "export interface BlockCatalogEntry {",
    "  contract: BlockTypeSpec;",
    "  ui: BlockUiHints;",
    "  defaults: Record<string, WorkflowParamValue>;",
    "  inputs: Record<string, WorkflowBlockInputContract>;",
    "  additionalInputs: WorkflowBlockAdditionalInputContract[];",
    "  execution: BlockExecutionKind;",
    "}",
    "",
    "export interface BlockManifest extends Omit<BlockCatalogEntry, \"additionalInputs\"> {",
    "  type: WorkflowBlockType;",
    "  paramsSchema: unknown;",
    "  additionalInputs?: WorkflowBlockAdditionalInputContract[];",
    "}",
    "",
  ];
}

function catalogBody(
  records: ManifestRecord[],
  triggerTypes: string[],
): string[] {
  return [
    "export type WorkflowBlockType =",
    ...records.map((record, index) =>
      "  | " + JSON.stringify(record.type) + (index === records.length - 1 ? ";" : ""),
    ),
    "",
    "export const BLOCK_CATALOG: Record<WorkflowBlockType, BlockCatalogEntry> = {",
    ...records.flatMap((record) => renderCatalogEntry(record)),
    "};",
    "",
    "export const BLOCK_TYPE_SPECS: Record<WorkflowBlockType, BlockTypeSpec> = {",
    ...records.map((record) => "  " + record.type + ": BLOCK_CATALOG." + record.type + ".contract,"),
    "};",
    "",
    "export const GENERATED_TRIGGER_BLOCK_TYPES: readonly WorkflowBlockType[] = [",
    ...triggerTypes.map((type) => "  " + JSON.stringify(type) + ","),
    "];",
  ];
}

export function renderCatalog(records: ManifestRecord[]): string {
  const triggerTypes = records
    .filter((record) => record.category === "trigger")
    .map((record) => record.type);
  const lines = [...catalogHeader(), ...catalogBody(records, triggerTypes)];
  return lines.join("\n") + "\n";
}

export function renderParams(
  records: ManifestRecord[],
  outputFile: string,
  root: string,
): string {
  const lines = [GENERATED_HEADER.trimEnd(), ""];
  for (const record of records) {
    const target = join(
      root,
      "apps/worker/src/engine/blocks",
      record.directory,
      "manifest.ts",
    );
    lines.push(
      "import { manifest as " +
        camelCase(record.directory) +
        "Manifest } from " +
        JSON.stringify(importPath(outputFile, target).replace(/\.ts$/u, ".js")) +
        ";",
    );
  }
  lines.push(
    "",
    "export const BLOCK_PARAM_SCHEMAS = {",
    ...records.map(
      (record) =>
        "  " +
        record.type +
        ": " +
        camelCase(record.directory) +
        "Manifest.paramsSchema,",
    ),
    "} as const;",
    "",
    "export const paramsSchemas = BLOCK_PARAM_SCHEMAS;",
    "",
    ...records.map(
      (record) =>
        "export const " +
        camelCase(record.directory) +
        "Params = BLOCK_PARAM_SCHEMAS." +
        record.type +
        ";",
    ),
  );
  return lines.join("\n") + "\n";
}

export function renderExecutors(
  records: ManifestRecord[],
  outputFile: string,
  root: string,
): string {
  const mapRecords = records.filter((record) => record.execution === "map");
  const lines = [GENERATED_HEADER.trimEnd(), ""];
  for (const record of mapRecords) {
    const target = join(
      root,
      "apps/worker/src/engine/blocks",
      record.directory,
      "execute.ts",
    );
    lines.push(
      "import { execute as " +
        camelCase(record.directory) +
        "Execute } from " +
        JSON.stringify(importPath(outputFile, target).replace(/\.ts$/u, ".js")) +
        ";",
    );
  }
  lines.push(
    "import type { BlockExecuteFn } from \"./support/types.js\";",
    "import type { WorkflowBlockType } from \"@shared/contracts\";",
    "",
    "export const BLOCK_EXECUTORS: Partial<Record<WorkflowBlockType, BlockExecuteFn>> = {",
    ...mapRecords.map(
      (record) => "  " + record.type + ": " + camelCase(record.directory) + "Execute,",
    ),
    "};",
    "",
  );
  const inlineRecords = records.filter((record) => record.execution === "inline");
  if (inlineRecords.length === 0) {
    lines.push("export const INLINE_EXECUTED_BLOCK_TYPES: readonly WorkflowBlockType[] = [];");
  } else {
    lines.push(
      "export const INLINE_EXECUTED_BLOCK_TYPES: readonly WorkflowBlockType[] = [",
      ...inlineRecords.map((record) => "  " + JSON.stringify(record.type) + ","),
      "];",
    );
  }
  return lines.join("\n") + "\n";
}

export function renderGeneratedFiles(options: GeneratorOptions): GeneratedFiles {
  const records = readManifests(options);
  const paths = outputPaths(options);
  return {
    catalog: renderCatalog(records),
    params: renderParams(records, paths.params, options.root),
    executors: renderExecutors(records, paths.executors, options.root),
  };
}

export { outputPaths };
