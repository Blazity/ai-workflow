/**
 * What integrations this build ships and what they declare.
 *
 * Core asks this package instead of naming a provider: which integrations
 * exist, what each one needs to connect, which capabilities it serves, which
 * blocks it unlocks, which screens and health checks it brings. The answers
 * are the manifests, which are plain data, so this entry is safe in a browser
 * and inside the Workflow DevKit flow bundle. The code behind the manifests is
 * in `@integrations/registry/worker`, which is server only.
 *
 * `manifests.generated.ts` is written by `pnpm run gen:integrations` from the
 * directories under `integrations/`. Nothing here is edited by hand, and
 * nothing here knows an id: a lookup takes the id its caller already holds.
 */
import type { IntegrationBlockManifest, IntegrationManifest } from "@integrations/sdk";
import { generatedIntegrationManifests } from "./manifests.generated";

export const integrationManifests: readonly IntegrationManifest[] =
  generatedIntegrationManifests;

const byId = new Map(generatedIntegrationManifests.map((manifest) => [manifest.id, manifest]));

/** The manifest of one integration, or nothing when this build does not ship it. */
export function integrationManifest(id: string): IntegrationManifest | undefined {
  return byId.get(id);
}

/** Whether this build ships an integration under that id. */
export function hasIntegration(id: string): boolean {
  return byId.has(id);
}

/**
 * One block of one integration. A workflow definition stores a block type and
 * nothing else, so the entry carries the integration the type belongs to.
 */
export interface IntegrationBlockEntry {
  readonly integrationId: string;
  readonly block: IntegrationBlockManifest;
}

export const integrationBlocks: readonly IntegrationBlockEntry[] =
  generatedIntegrationManifests.flatMap((manifest) =>
    manifest.blocks.map((block) => ({ integrationId: manifest.id, block })),
  );

const byBlockType = new Map(integrationBlocks.map((entry) => [entry.block.type, entry]));

/** The integration and block a stored block type names, or nothing. */
export function integrationBlock(type: string): IntegrationBlockEntry | undefined {
  return byBlockType.get(type);
}

/** Every integration that can serve a capability, in registry order. */
export function integrationsProviding(capability: string): readonly IntegrationManifest[] {
  return generatedIntegrationManifests.filter((manifest) =>
    (manifest.capabilities as readonly string[]).includes(capability),
  );
}
