import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { outputPaths, renderGeneratedFiles } from "./render.js";
import { FIXTURE_FLAG, type GeneratedFiles, type GeneratorOptions } from "./types.js";

export function generateIntegrationRegistry(options: GeneratorOptions): GeneratedFiles {
  const generated = renderGeneratedFiles(options);
  const paths = outputPaths(options);
  for (const [name, content] of Object.entries(generated) as Array<
    [keyof GeneratedFiles, string]
  >) {
    mkdirSync(dirname(paths[name]), { recursive: true });
    writeFileSync(paths[name], content);
  }
  return generated;
}

export function staleGeneratedFiles(options: GeneratorOptions): Array<keyof GeneratedFiles> {
  const generated = renderGeneratedFiles(options);
  const paths = outputPaths(options);
  return (Object.keys(generated) as Array<keyof GeneratedFiles>).filter(
    (name) =>
      !existsSync(paths[name]) || readFileSync(paths[name], "utf8") !== generated[name],
  );
}

/** Whether the committed registry is the one generated without fixtures. */
export function checkIntegrationRegistry(options: Omit<GeneratorOptions, "includeFixtures">): boolean {
  const committed = { ...options, includeFixtures: false };
  const paths = outputPaths(committed);
  const stale = staleGeneratedFiles(committed);
  if (stale.length === 0) {
    console.log("integration registry files are current");
    return true;
  }
  console.error("integration registry files are stale:");
  for (const name of stale) console.error(`  ${relative(options.root, paths[name])}`);
  console.error(
    `Run pnpm run gen:integrations. The committed registry is the one generated without ${FIXTURE_FLAG}, so unset it first if this shell exports it.`,
  );
  return false;
}
