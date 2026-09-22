/**
 * Which provider serves each capability on this deployment, for the
 * Integrations page.
 *
 * It decides nothing of its own. Which integrations are usable comes from the
 * one state derivation in `services/integrations`; who counts as a provider of
 * a capability comes from the engine's own `deploymentIntegrations`, the value
 * the palette and a run reason over; and memory comes from `activeMemory`, the
 * call a run makes. Memory is asked separately because it is the one
 * capability core serves by itself when nothing is connected (ADR-010,
 * decision 21), and a second statement of that rule here would drift from the
 * one runs follow.
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
        cardinality: capability.cardinality,
        declaredBy: input.manifests
          .filter((manifest) => (manifest.capabilities as readonly string[]).includes(id))
          .map((manifest) => manifest.id),
        serving:
          id === "memory"
            ? memoryServing(input.memory, usable)
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

/** Memory as `activeMemory` resolved it, which is what the next run gets. */
function memoryServing(memory: MemoryAnswer, usable: readonly string[]): IntegrationCapabilityServing {
  if (memory.refusal === null) {
    if (memory.id === BUILTIN_MEMORY_PROVIDER_ID) return { kind: "builtin", name: memory.name };
    if (memory.id !== null) return { kind: "integrations", ids: [memory.id] };
  }
  if (memory.refusal?.code === "ambiguous") return { kind: "ambiguous", ids: usable };
  return {
    kind: "unknown",
    reason: memory.refusal?.detail ?? "memory resolved to no provider and gave no reason",
  };
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
