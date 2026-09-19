import { dirname, join, relative } from "node:path";
import { readIntegrations } from "./read-integrations.js";
import {
  DEFAULT_OUTPUT_PATHS,
  GENERATED_HEADER,
  type GeneratedFiles,
  type GeneratorOptions,
  type IntegrationRecord,
} from "./types.js";

export function outputPaths(
  options: GeneratorOptions,
): Record<keyof GeneratedFiles, string> {
  return {
    manifests:
      options.outputPaths?.manifests ?? join(options.root, DEFAULT_OUTPUT_PATHS.manifests),
    runtimes:
      options.outputPaths?.runtimes ?? join(options.root, DEFAULT_OUTPUT_PATHS.runtimes),
  };
}

/**
 * Entries are imported by path rather than by package name, the way the block
 * catalog imports block manifests: the registry then needs no dependency on
 * every integration, so adding one is a generator run rather than a package
 * edit plus a lockfile change.
 */
function importPath(fromFile: string, targetFile: string): string {
  const path = relative(dirname(fromFile), targetFile).replaceAll("\\", "/");
  return (path.startsWith(".") ? path : `./${path}`).replace(/\.tsx?$/u, "");
}

/** `demo` and `demo-two` both have to be legal identifiers in the generated file. */
function alias(id: string): string {
  return id.replaceAll(/[^A-Za-z0-9]/gu, "_");
}

/** A build that ships no integration renders an empty list, not a blank line in brackets. */
function renderList(declaration: string, records: IntegrationRecord[]): string[] {
  if (records.length === 0) return [`${declaration} [];`];
  return [`${declaration} [`, ...records.map((record) => `  ${alias(record.id)},`), "];"];
}

function renderManifests(
  records: IntegrationRecord[],
  outputPath: string,
  root: string,
): string {
  const imports = records.map(
    (record) =>
      `import { manifest as ${alias(record.id)} } from "${importPath(outputPath, join(root, record.manifestPath))}";`,
  );
  return [
    GENERATED_HEADER.trimEnd(),
    "",
    "/**",
    " * The manifest of every integration this build ships.",
    " *",
    " * Plain data: the dashboard reads it in a browser and the Workflow DevKit",
    " * reads it inside the flow bundle, so this file imports manifest entries",
    " * only. Worker entries are in ./runtimes.generated.ts, behind a separate",
    " * module of this package.",
    " */",
    'import type { IntegrationManifest } from "@integrations/sdk";',
    ...imports,
    "",
    ...renderList(
      "export const generatedIntegrationManifests: readonly IntegrationManifest[] =",
      records,
    ),
    "",
    "/**",
    " * Which of the above are fixtures, generated in behind INTEGRATION_FIXTURES.",
    " *",
    " * Empty in every committed registry and in every deployed build. It exists",
    " * so a check about what this build SHIPS can tell the two apart: the",
    " * connection-shape guard is committed against the real registry, and a local",
    " * fixture run must not read as a shape change nobody made.",
    " */",
    `export const generatedIntegrationFixtureIds: readonly string[] = [${records
      .filter((record) => record.fixture)
      .map((record) => JSON.stringify(record.id))
      .join(", ")}];`,
    "",
  ].join("\n");
}

function renderRuntimes(
  records: IntegrationRecord[],
  outputPath: string,
  root: string,
): string {
  const imports = records.map(
    (record) =>
      `import { runtime as ${alias(record.id)} } from "${importPath(outputPath, join(root, record.workerPath))}";`,
  );
  return [
    GENERATED_HEADER.trimEnd(),
    "",
    "/**",
    " * The worker entry of every integration this build ships: provider SDKs,",
    " * Node modules and secrets. Server only. Nothing that reaches a browser or",
    " * the Workflow DevKit flow bundle may import this file or the module that",
    " * re-exports it.",
    " */",
    'import type { ErasedIntegrationRuntime } from "@integrations/sdk";',
    ...imports,
    "",
    ...renderList(
      "export const generatedIntegrationRuntimes: readonly ErasedIntegrationRuntime[] =",
      records,
    ),
    "",
  ].join("\n");
}

export function renderGeneratedFiles(options: GeneratorOptions): GeneratedFiles {
  const records = readIntegrations(options);
  const paths = outputPaths(options);
  return {
    manifests: renderManifests(records, paths.manifests, options.root),
    runtimes: renderRuntimes(records, paths.runtimes, options.root),
  };
}
