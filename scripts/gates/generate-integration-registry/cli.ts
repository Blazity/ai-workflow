import { resolve } from "node:path";
import { checkIntegrationRegistry, generateIntegrationRegistry } from "./check.js";
import { readIntegrations } from "./read-integrations.js";
import { FIXTURE_FLAG, type GeneratorOptions } from "./types.js";

function argumentValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

/**
 * Fixtures are a generation-time decision, not a runtime one: the registry a
 * build compiles either imports `integrations/_fixtures` or does not. Only a
 * local generation sets the variable; the committed registry, which every
 * build compiles and `--check` compares against, is the one generated without
 * it.
 */
function includeFixtures(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[FIXTURE_FLAG];
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

export function main(args = process.argv.slice(2)): void {
  const root = resolve(
    argumentValue(args, "--root") ?? resolve(import.meta.dirname, "../../.."),
  );
  const options: GeneratorOptions = { root, includeFixtures: includeFixtures() };
  // One id per line, so a gate written in another language reads the set from
  // the same place the registry is built from instead of keeping its own list.
  if (args.includes("--print-ids")) {
    for (const record of readIntegrations(options)) console.log(record.id);
    return;
  }
  if (args.includes("--check")) {
    process.exitCode = checkIntegrationRegistry(options) ? 0 : 1;
    return;
  }
  generateIntegrationRegistry(options);
  console.log(
    options.includeFixtures === true
      ? "generated integration registry files, fixtures included"
      : "generated integration registry files",
  );
}
