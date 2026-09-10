import { resolve } from "node:path";
import { main } from "./generate-block-catalog/cli.js";

export type {
  GeneratedFiles,
  GeneratorOptions,
  ManifestRecord,
} from "./generate-block-catalog/types.js";
export { compareCodePoints } from "./generate-block-catalog/types.js";
export { readManifests } from "./generate-block-catalog/read-manifests.js";
export {
  renderCatalog,
  renderExecutors,
  renderGeneratedFiles,
  renderParams,
} from "./generate-block-catalog/render.js";
export {
  checkBlockCatalog,
  generateBlockCatalog,
  staleGeneratedFiles,
} from "./generate-block-catalog/check.js";
export { main } from "./generate-block-catalog/cli.js";

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.dirname, "generate-block-catalog.ts")
) {
  main();
}
