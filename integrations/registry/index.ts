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
import {
  generatedIntegrationFixtureIds,
  generatedIntegrationManifests,
} from "./manifests.generated";

export const integrationManifests: readonly IntegrationManifest[] =
  generatedIntegrationManifests;

/**
 * The ids of the manifests above that are fixtures, generated in behind
 * INTEGRATION_FIXTURES. Empty in every committed registry and every deployed
 * build, so a check about what this deployment SHIPS can leave them out.
 */
export const integrationFixtureIds: readonly string[] = generatedIntegrationFixtureIds;

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

/**
 * What a person reads for a capability (`Issue tracker`, `Version control`),
 * or null for an id this build does not know. Defined in the SDK beside its
 * table, and offered here for the dashboard, which reads the registry.
 */
export { capabilityLabel } from "@integrations/sdk";

/** How a person reads one change request: `MR` and `!12`, `PR` and `#12`. */
export interface ChangeRequestNaming {
  readonly noun: string;
  readonly reference: string;
}

/** How a change request is named when no provider says otherwise. */
const PULL_REQUEST = { noun: "PR", referencePrefix: "#" } as const;

/**
 * How one change request is named, in its provider's own words
 * (`repositories.changeRequest` in the manifest). The one reader of that
 * declaration: the dashboard's links call it, and core stamps its reference on
 * every pull request it hands a messaging integration, so the run view and a
 * chat message cannot name the same merge request two ways.
 *
 * The provider is the one the row records when this build ships it. A row
 * that records none (a gate run, a run from before the provider was stored)
 * or one this build no longer ships is matched by the link segment its URL
 * carries, the longest segment winning so a provider's specific shape is never
 * shadowed by another's shorter one. Nothing matching reads `PR` and `#`.
 *
 * `manifests` is a parameter so the rule can be driven for a deployment that
 * is not this build's; callers leave it out.
 */
export function changeRequestNaming(
  pr: { readonly provider: string; readonly id: number; readonly url: string },
  manifests: readonly IntegrationManifest[] = integrationsProviding("vcs"),
): ChangeRequestNaming {
  const shape = changeRequestOwner(pr, manifests)?.repositories?.changeRequest ?? PULL_REQUEST;
  return { noun: shape.noun, reference: `${shape.referencePrefix}${pr.id}` };
}

function changeRequestOwner(
  pr: { readonly provider: string; readonly url: string },
  manifests: readonly IntegrationManifest[],
): IntegrationManifest | undefined {
  const recorded = pr.provider
    ? manifests.find((manifest) => manifest.id === pr.provider)
    : undefined;
  if (recorded) return recorded;
  let found: { manifest: IntegrationManifest; length: number } | undefined;
  for (const manifest of manifests) {
    const segment = manifest.repositories?.changeRequest?.linkSegment;
    if (!segment || !pr.url.includes(segment)) continue;
    if (!found || segment.length > found.length) found = { manifest, length: segment.length };
  }
  return found?.manifest;
}
