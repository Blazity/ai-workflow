/**
 * What an agent building workflows over MCP is told about this deployment's
 * integrations, and what it is deliberately not told.
 *
 * The caller here is a model, and the boundary Jakub drew on 2026-09-18 is
 * about what reaches a model's context: connecting, testing, enabling and
 * configuring an integration are dashboard actions, so no tool here does them
 * and no response here carries a connection value, a secret or the name of a
 * variable somebody could be asked to paste one into. What an agent DOES need
 * is which blocks it may put in a graph right now, which is a capability fact
 * and carries none of that.
 *
 * Two pieces, and the split is the point:
 *
 * - `agentFacingIntegrations` is the same deployment with the admin's own
 *   words taken out. Every sentence the engine composes about an unusable
 *   integration reads `failure.message`, which S2 fills with the one thing an
 *   admin needs and an agent must not have ("Set DEMO_API_TOKEN on this
 *   deployment"). Replacing that ONE value is why nothing here is a regex over
 *   a finished sentence: the palette, the draft issue and the publish refusal
 *   all keep coming from the resolver, and they come out agent-safe.
 * - `integrationFactsOf` is what `system.capabilities` publishes, and it reads
 *   the availability verdict off the very contracts the editor's palette is
 *   built from, so the two cannot disagree about the same deployment.
 *
 * Nothing here is cached. Disabling an integration is the kill switch an admin
 * reaches for, and on Vercel the next call lands on a warm invocation where a
 * module-level cache would keep answering with the catalog that admin just
 * revoked.
 */
import type {
  IntegrationCapabilitiesResponse,
  IntegrationCapabilityDto,
  IntegrationFailure,
  IntegrationStatus,
  WorkflowBlockContract,
  WorkflowBlockType,
} from "@shared/contracts";

import { logger } from "../services/system/logger.js";
import {
  blockContractsFor,
  type DeploymentIntegrations,
  type RequestBlockContracts,
} from "../services/workflow-definitions/block-contracts.js";


/**
 * One integration as this module reads it.
 *
 * Declared structurally rather than imported from the engine: the MCP tier may
 * not reach into `engine/`, and stating the four fields it reads is also a
 * statement that a connection value could not arrive here even by accident.
 */
interface IntegrationPresenceView {
  readonly id: string;
  readonly name: string;
  readonly status: IntegrationStatus;
  readonly usable: boolean;
  readonly failure: IntegrationFailure | null;
  readonly capabilities: readonly string[];
}

interface DeploymentIntegrationsView {
  readonly byId: ReadonlyMap<string, IntegrationPresenceView>;
  readonly blocks: ReadonlyMap<string, { readonly integrationId: string }>;
}

/** One integration, and the blocks it lets an agent use right now. */
export interface McpIntegrationFact {
  readonly id: string;
  readonly name: string;
  /** `connected`, `not_connected`, `failing` or `disabled`. Never how it got there. */
  readonly status: IntegrationStatus;
  /** Enabled and connected: whether its blocks can run at all. */
  readonly usable: boolean;
  /** The capability ids it declares. Which one is active is `capabilities`,
   *  the envelope's other field, which the resolvers a run uses decided. */
  readonly capabilities: readonly string[];
  readonly blocks: readonly McpIntegrationBlockFact[];
}

interface McpIntegrationBlockFact {
  readonly type: string;
  readonly available: boolean;
  /** The resolver's own sentence, or null when the block can run. */
  readonly unavailableReason: string | null;
}

/**
 * What an agent may be told about a connection that is not working.
 *
 * It names the integration (through the sentence the engine wraps it in), says
 * the state, and points at the one place an admin can act. It never names a
 * variable, a field or a stored value: a model that knows the variable name is
 * one prompt away from asking a person to paste a token into a chat, which is
 * the whole reason integration management is not on this surface.
 */
const AGENT_FACING_FAILURE_DETAIL =
  "its connection is not working; an admin can fix it on the Integrations page in the dashboard";

/**
 * The same deployment, with the admin's own wording replaced by the agent's.
 *
 * Returned unchanged when there is nothing to replace, so a build shipping no
 * integration pays nothing and a caller can compare by identity.
 *
 * `usable` and `status` are untouched, which is what keeps the verdict the
 * editor and MCP share exactly one verdict. `missingVariables` and
 * `missingFields` do not survive: they are the same answer in structured form.
 */
export function agentFacingIntegrations<T extends DeploymentIntegrationsView>(
  integrations: T,
): T {
  let changed = false;
  const byId = new Map<string, IntegrationPresenceView>();
  for (const [id, presence] of integrations.byId) {
    if (presence.failure === null) {
      byId.set(id, presence);
      continue;
    }
    changed = true;
    byId.set(id, {
      ...presence,
      // The reason survives because it is a closed enum this deployment owns;
      // only the message and the two name lists carry configuration.
      failure: { reason: presence.failure.reason, message: AGENT_FACING_FAILURE_DETAIL },
    });
  }
  return changed ? { ...integrations, byId } : integrations;
}

/**
 * What `system.capabilities` publishes about integrations.
 *
 * `registry` must be the palette built from the same deployment (and from the
 * agent-facing view of it, so the sentences are the ones a model may read):
 * every verdict below is read off it rather than recomputed, so there is no
 * second rule that could come to disagree with the editor.
 *
 * No sentence of this module's own sits beside them. `status` and `usable` are
 * the machine-readable answer, the per-block sentence is the resolver's, and a
 * third wording for the same state is how a surface starts drifting.
 */
export function integrationFactsOf(
  integrations: DeploymentIntegrationsView,
  registry: Record<WorkflowBlockType, WorkflowBlockContract>,
): McpIntegrationFact[] {
  const blocksByIntegration = new Map<string, McpIntegrationBlockFact[]>();
  for (const [type, entry] of integrations.blocks) {
    const availability = registry[type as WorkflowBlockType]?.availability;
    const facts = blocksByIntegration.get(entry.integrationId) ?? [];
    facts.push({
      type,
      // A block the palette does not describe at all is reported as
      // unavailable rather than skipped: an agent that never sees the type
      // cannot tell "this build has no such block" from "I forgot to ask".
      available: availability?.available ?? false,
      unavailableReason: availability?.available
        ? null
        : availability?.unavailableReason ?? "This deployment cannot describe the block.",
    });
    blocksByIntegration.set(entry.integrationId, facts);
  }
  return [...integrations.byId.values()].map((presence) => ({
    id: presence.id,
    name: presence.name,
    status: presence.status,
    usable: presence.usable,
    capabilities: [...presence.capabilities],
    blocks: blocksByIntegration.get(presence.id) ?? [],
  }));
}

/**
 * The block data every authoring tool on this surface works from.
 *
 * One read of the integration state per call, shared by the contracts and the
 * facts, so one MCP call answers about one deployment. Reading it twice is how
 * `blocks.list` and `system.capabilities` would come to describe two different
 * moments inside the same conversation.
 */
function agentFacingBlockData(deployment: DeploymentIntegrations): {
  contracts: RequestBlockContracts;
  integrations: DeploymentIntegrationsView;
} {
  const integrations = agentFacingIntegrations(deployment);
  return { contracts: blockContractsFor(undefined, integrations), integrations };
}

/** The contracts alone, for a tool with no integration facts to publish. */
export function agentFacingBlockContracts(
  deployment: DeploymentIntegrations,
): RequestBlockContracts {
  return agentFacingBlockData(deployment).contracts;
}

/**
 * The deployment itself, for a service that decides from it rather than from a
 * block contract (the dispatch preflight).
 *
 * `null` when the state could not be read, so the caller falls back to whatever
 * it would have done on its own rather than answering from an empty deployment,
 * which would read as "no integration is connected" and block nothing.
 */
export async function agentFacingDeploymentIntegrations(
  read: () => Promise<DeploymentIntegrations>,
): Promise<DeploymentIntegrations | null> {
  try {
    return agentFacingIntegrations(await read());
  } catch {
    return null;
  }
}

/**
 * This deployment's integrations, read ONCE for a `system.capabilities` call,
 * or `null` when they could not be read.
 *
 * Every field of that answer that depends on them is built from this one
 * value, so one call describes one moment, and each says "could not be read"
 * (null) rather than "none" when the read failed: an agent told that nothing
 * watches its authoring writes, or that nothing serves a capability, because
 * a database did not answer for a moment would act on a falsehood.
 *
 * It never throws. This is the first call every client makes, and it is where
 * protocol versions, the contract hash and the announcement channel come from;
 * a build that ships integrations would otherwise turn a database hiccup into a
 * dependency failure on the one call a client needs to get its bearings.
 */
export async function readDeploymentIntegrationsForFacts(
  read: () => Promise<DeploymentIntegrations>,
): Promise<DeploymentIntegrations | null> {
  try {
    return await read();
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "mcp_integration_facts_unavailable",
    );
    return null;
  }
}

/**
 * Every integration this deployment ships, as `system.capabilities` reports it,
 * or `null` when that state could not be read at all.
 *
 * `null` and `[]` are different answers and an agent has to be able to tell
 * them apart: the empty list means this build ships no integration, and null
 * means the read failed and nothing should be concluded from it.
 */
export function deploymentIntegrationFacts(
  deployment: DeploymentIntegrations | null,
): McpIntegrationFact[] | null {
  if (deployment === null) return null;
  const { contracts, integrations } = agentFacingBlockData(deployment);
  // The registry is built only when there is something to report: a
  // deployment with no integration has no fact to publish and should not
  // resolve forty core contracts to say so.
  if (integrations.byId.size === 0) return [];
  return integrationFactsOf(integrations, contracts.blockRegistry());
}

/**
 * What an agent may read where the resolver refused a provider it chose.
 *
 * The admin's sentence carries the provider's own failure text, which is where
 * S2 puts "Set DEMO_API_TOKEN on this deployment"; the kind and the ids already
 * say what happened and to whom.
 */
const AGENT_FACING_REFUSED_REASON =
  "the provider chosen for it is not working, so nothing serves it; an admin can fix it on the Integrations page in the dashboard";

/** And where the deployment could not say who serves it at all. */
const AGENT_FACING_UNKNOWN_REASON =
  "which provider serves it could not be read just now; an admin can look on the Integrations page in the dashboard";

/**
 * Who serves each capability, as an agent may read it: the rows the
 * Integrations page shows, with every sentence composed for an admin replaced
 * by one composed for a model. Replaced whole, never pattern-matched, for the
 * reason `agentFacingIntegrations` gives.
 */
function agentFacingCapabilities(
  capabilities: readonly IntegrationCapabilityDto[],
): IntegrationCapabilityDto[] {
  return capabilities.map((capability) => {
    const serving = capability.serving;
    if (serving.kind === "refused") {
      return { ...capability, serving: { ...serving, reason: AGENT_FACING_REFUSED_REASON } };
    }
    if (serving.kind === "unknown") {
      return { ...capability, serving: { ...serving, reason: AGENT_FACING_UNKNOWN_REASON } };
    }
    return capability;
  });
}

/**
 * The capability rows `system.capabilities` publishes, over the deployment the
 * call already read, or `null` when they could not be read, which is not
 * "nothing serves anything". It never throws, for the reason
 * `readDeploymentIntegrationsForFacts` gives.
 */
export async function deploymentCapabilityFacts(
  deployment: DeploymentIntegrations | null,
  read: (deployment: DeploymentIntegrations) => Promise<IntegrationCapabilitiesResponse>,
): Promise<IntegrationCapabilityDto[] | null> {
  if (deployment === null) return null;
  try {
    return agentFacingCapabilities((await read(deployment)).capabilities);
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "mcp_capability_facts_unavailable",
    );
    return null;
  }
}
