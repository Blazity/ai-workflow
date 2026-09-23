/**
 * The code behind the manifests: connection tests, capability adapters, block
 * executors and health probes.
 *
 * Server only. Importing this module pulls in every integration's worker
 * entry, which may use Node modules and provider SDKs, so nothing that reaches
 * a browser or the Workflow DevKit flow bundle may import it. The boundaries
 * gate holds that line; the failure it prevents shows up only in a Vercel
 * build, never in a local test.
 *
 * `runtimes.generated.ts` is written by `pnpm run gen:integrations`.
 */
import type { ErasedIntegrationRuntime } from "@integrations/sdk";
import { generatedIntegrationRuntimes } from "./runtimes.generated";

export const integrationRuntimes: readonly ErasedIntegrationRuntime[] =
  generatedIntegrationRuntimes;

const byId = new Map(
  generatedIntegrationRuntimes.map((runtime) => [runtime.manifest.id, runtime]),
);

/** The runtime of one integration, or nothing when this build does not ship it. */
export function integrationRuntime(id: string): ErasedIntegrationRuntime | undefined {
  return byId.get(id);
}
