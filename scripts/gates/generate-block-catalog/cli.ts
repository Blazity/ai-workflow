import { resolve } from "node:path";
import { checkBlockCatalog, generateBlockCatalog } from "./check.js";
import type { GeneratorOptions } from "./types.js";

function argumentValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export function main(args = process.argv.slice(2)): void {
  const root = resolve(
    argumentValue(args, "--root") ?? resolve(import.meta.dirname, "../../.."),
  );
  const options: GeneratorOptions = { root };
  if (args.includes("--check")) {
    process.exitCode = checkBlockCatalog(options) ? 0 : 1;
    return;
  }
  generateBlockCatalog(options);
  console.log("generated block catalog files");
}
