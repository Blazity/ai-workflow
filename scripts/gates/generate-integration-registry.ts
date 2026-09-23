/**
 * Writes the registries that let core ask which integrations exist without
 * naming one: `integrations/registry/manifests.generated.ts` (plain data, safe
 * for a browser and for the Workflow DevKit flow bundle) and
 * `integrations/registry/runtimes.generated.ts` (server only).
 *
 * The set is the directories under `integrations/`, so adding an integration is
 * a folder plus one run of this. `--check` fails on a stale registry, which is
 * what CI runs; see `generate-block-catalog.ts` for the same contract over
 * core's blocks.
 */
import { resolve } from "node:path";
import { main } from "./generate-integration-registry/cli.js";

export { readIntegrations } from "./generate-integration-registry/read-integrations.js";
export { renderGeneratedFiles } from "./generate-integration-registry/render.js";
export {
  generateIntegrationRegistry,
  staleGeneratedFiles,
} from "./generate-integration-registry/check.js";

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.dirname, "generate-integration-registry.ts")
) {
  main();
}
