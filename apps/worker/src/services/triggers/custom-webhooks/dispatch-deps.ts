import type { RunRegistryAdapter } from "../../../adapters/run-registry/types.js";
import type { Db } from "../../../db/client.js";
import {
  envTriggerRateLimitDefault,
  resolveTriggerRateLimit,
  triggerNodeRateLimitParams,
  type TriggerRateLimitConfig,
} from "../../dispatch/index.js";
import { maxConcurrentAgents, triggerRateLimitDefaults } from "../../settings/index.js";
import type {
  WebhookDispatchDeps,
  WebhookDispatchGuardRejection,
  WebhookDispatchTarget,
} from "../../webhook-trigger/index.js";
import {
  getWebhookEndpointById,
} from "../../../webhook-trigger/endpoint-store.js";
import {
  getEnabledDeployedDefinition,
  getWorkflowDefinitionVersion,
  runnableDefinitionOf,
} from "../../../db/repositories/definitions.js";

/**
 * Deps for dispatching a webhook delivery, shared by the ingress route and the
 * cron drain so both paths apply the same guard. The guard re-reads state under
 * the subject reservation, because an endpoint can be revoked or a definition
 * disabled while a delivery waits, and it checks the node against the version
 * the delivery is pinned to rather than the current head: that is the graph the
 * run executes.
 */
export function createWebhookDispatchDeps(
  db: Db,
  runRegistry: RunRegistryAdapter,
): WebhookDispatchDeps {
  return {
    db,
    runRegistry,
    maxConcurrentAgents: maxConcurrentAgents(),
    ensureStillDispatchable: (target) => ensureStillDispatchable(db, target),
    resolveTriggerRateLimit: (target) => resolveWebhookTriggerRateLimit(db, target),
  };
}

/**
 * The webhook node's start budget, read from the version the delivery is pinned
 * to so the limit is the one authored in the graph this run would execute. The
 * node's own params beat the env default, and no configuration at all means
 * unlimited.
 *
 * The endpoint's own limits (ingress and inbox) are unrelated and still apply:
 * this is an additional, per-node cap, so the effective ceiling is the smallest
 * of the three.
 */
async function resolveWebhookTriggerRateLimit(
  db: Db,
  target: WebhookDispatchTarget,
): Promise<TriggerRateLimitConfig | null> {
  const pinned = await getWorkflowDefinitionVersion(
    db,
    target.definitionId,
    target.definitionVersion,
  );
  return resolveTriggerRateLimit(
    triggerNodeRateLimitParams(runnableDefinitionOf(pinned), target.nodeId),
    envTriggerRateLimitDefault(triggerRateLimitDefaults()),
  );
}

async function ensureStillDispatchable(
  db: Db,
  target: WebhookDispatchTarget,
): Promise<WebhookDispatchGuardRejection | null> {
  const endpoint = await getWebhookEndpointById(db, target.endpointId);
  if (!endpoint || endpoint.revokedAt) return "endpoint_revoked";

  const live = await getEnabledDeployedDefinition(db, target.definitionId);
  if (!live || !live.current) return "definition_disabled";

  const pinned = await getWorkflowDefinitionVersion(
    db,
    target.definitionId,
    target.definitionVersion,
  );
  const pinnedGraph = runnableDefinitionOf(pinned);
  if (!pinnedGraph || !webhookNodeOf(pinnedGraph.nodes, target.nodeId)) {
    return "node_missing";
  }
  return null;
}

/** A trigger_webhook node only exists in a v2 graph, so matching on the type is
 *  also what narrows the node away from a v1 shape. */
export function webhookNodeOf(
  nodes: readonly { id: string; type: string; configuration?: unknown }[],
  nodeId: string,
): { configuration: unknown } | null {
  const node = nodes.find((n) => n.id === nodeId && n.type === "trigger_webhook");
  return node ? { configuration: node.configuration ?? {} } : null;
}
