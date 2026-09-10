import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { renderGeneratedFiles, outputPaths } from "./render.js";
import {
  type GeneratedFiles,
  type GeneratorOptions,
} from "./types.js";

function generatedPaths(options: GeneratorOptions): Record<keyof GeneratedFiles, string> {
  return outputPaths(options);
}

export function generateBlockCatalog(options: GeneratorOptions): GeneratedFiles {
  const generated = renderGeneratedFiles(options);
  const paths = generatedPaths(options);
  for (const [name, content] of Object.entries(generated) as Array<
    [keyof GeneratedFiles, string]
  >) {
    const path = paths[name];
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return generated;
}

export function staleGeneratedFiles(options: GeneratorOptions): string[] {
  const generated = renderGeneratedFiles(options);
  const paths = generatedPaths(options);
  return (Object.keys(generated) as Array<keyof GeneratedFiles>).filter(
    (name) =>
      !existsSync(paths[name]) ||
      readFileSync(paths[name], "utf8") !== generated[name],
  );
}

export function checkBlockCatalog(options: GeneratorOptions): boolean {
  const stale = staleGeneratedFiles(options);
  if (stale.length === 0) {
    console.log("block catalog generated files are current");
    return true;
  }
  console.error("block catalog generated files are stale:");
  for (const path of stale) console.error("  " + relative(options.root, path));
  return false;
}
