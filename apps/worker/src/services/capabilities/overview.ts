/**
 * Which provider serves each capability on this deployment, for the
 * Integrations page and for `system.capabilities` on MCP.
 *
 * Memory is the resolver's own decision, carried as it answered:
 * `activeMemory` is the call a run makes, and its refusal names the providers
 * it weighed, so this module never works out again who memory is about. It is
 * asked separately because memory is the one capability core serves by itself
 * when nothing is connected (ADR-010, decision 21).
 *
 * For every other capability the facts come from the engine's
 * `deploymentIntegrations` (the value the palette and a run reason over), and
 * ONE rule is stated here: two usable providers of a `one` capability serve
 * neither. That rule is also written in each runtime that resolves a
 * single-provider capability (the issue tracker, messaging, the palette's
 * `coreCapabilityIssue`), so this is one more statement of it, not a reading
 * of theirs; a change to it has to be made in all of them until one helper
 * holds it.
 */
import { integrationManifests } from "@integrations/registry";
import { INTEGRATION_CAPABILITIES, type IntegrationManifest } from "@integrations/sdk";
import type {
  IntegrationCapabilitiesResponse,
  IntegrationCapabilityDto,
  IntegrationCapabilityServing,
} from "@shared/contracts";

import {
  deploymentIntegrations,
  type DeploymentIntegrations,
} from "../../engine/definition/integration-availability.js";
import { activeMemory, type ActiveMemory } from "../../engine/support/memory-runtime.js";
import { BUILTIN_MEMORY_PROVIDER_ID } from "../../memory/builtin/adapter.js";
import { readIntegrationStates } from "../integrations/index.js";

/** What a run would be handed for memory, reduced to what a page can show. */
export type MemoryAnswer = Pick<ActiveMemory, "id" | "name" | "refusal">;

/**
 * The overview, over facts somebody else read. Pure, so a test declares a
 * deployment instead of arranging a database and an environment.
 */
export function capabilityOverview(input: {
  readonly manifests: readonly IntegrationManifest[];
  readonly deployment: DeploymentIntegrations;
  readonly memory: MemoryAnswer;
}): IntegrationCapabilityDto[] {
  return Object.entries(INTEGRATION_CAPABILITIES)
    // A reserved capability has no port, so nothing can serve it and a row
    // for it would only ever say so.
    .filter(([, capability]) => capability.reservedFor === null)
    .map(([id, capability]) => {
      const usable = input.deployment.providers.get(id) ?? [];
      return {
        id,
        label: capability.label,
        cardinality: capability.cardinality,
        declaredBy: input.manifests
          .filter((manifest) => (manifest.capabilities as readonly string[]).includes(id))
          .map((manifest) => manifest.id),
        serving:
          id === "memory"
            ? memoryServing(input.memory)
            : providerServing(capability.cardinality, usable),
      };
    });
}

/**
 * A capability only an integration can serve. Two usable providers of a `one`
 * capability are a refusal, never a pick of the first: the engine refuses
 * every block that needs it in that state, and the page says the same.
 */
function providerServing(
  cardinality: "one" | "many",
  usable: readonly string[],
): IntegrationCapabilityServing {
  if (usable.length === 0) return { kind: "none" };
  if (cardinality === "one" && usable.length > 1) return { kind: "ambiguous", ids: usable };
  return { kind: "integrations", ids: usable };
}

/**
 * Memory as `activeMemory` resolved it, which is what the next run gets. The
 * ids come off the refusal, never off the usable list: the resolver counts a
 * switched-on provider that is failing, and the usable list does not hold it.
 */
function memoryServing(memory: MemoryAnswer): IntegrationCapabilityServing {
  const refusal = memory.refusal;
  if (refusal === null) {
    if (memory.id === BUILTIN_MEMORY_PROVIDER_ID) return { kind: "builtin", name: memory.name };
    if (memory.id !== null) return { kind: "integrations", ids: [memory.id] };
    return { kind: "unknown", reason: "memory resolved to no provider and gave no reason" };
  }
  switch (refusal.code) {
    case "ambiguous":
      return { kind: "ambiguous", ids: refusal.providers };
    case "unreadable":
      return { kind: "unknown", reason: refusal.detail };
    default:
      return { kind: "refused", ids: refusal.providers, reason: refusal.detail };
  }
}

/** The overview for this deployment, read now. */
export async function readCapabilityOverview(): Promise<IntegrationCapabilitiesResponse> {
  const states = await readIntegrationStates();
  const memory = await activeMemory();
  return {
    capabilities: capabilityOverview({
      manifests: integrationManifests,
      deployment: deploymentIntegrations({ manifests: integrationManifests, states }),
      memory,
    }),
  };
}
