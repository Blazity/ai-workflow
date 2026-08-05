import type { WebhookAuthScheme, WebhookEndpointConfig } from "@shared/contracts";
import {
  createError,
  getRequestURL,
  getRouterParam,
  type H3Event,
} from "h3";
import { env } from "../../../../../../../../../env.js";
import type { Db } from "../../../../../../../../db/client.js";
import { requireDashboardActor } from "../../../../../../../../lib/auth/request-context.js";
import { canDispatchWorkflowRuns } from "../../../../../../../../lib/auth/roles.js";
import { logger } from "../../../../../../../../lib/logger.js";
import {
  getWebhookEndpointForNode,
  type MintableWebhookNode,
  type WebhookEndpointRow,
} from "../../../../../../../../webhook-trigger/endpoint-store.js";
import { getWebhookRejectionsToday } from "../../../../../../../../webhook-trigger/rejection-counters.js";
import {
  resolveWebhookHeaderName,
  resolveWebhookTimestampHeaderName,
} from "../../../../../../../../webhook-trigger/verify.js";
import {
  getDeployedWorkflowDefinitionVersion,
  getWorkflowDefinition,
} from "../../../../../../../../workflow-definition/store.js";
import { parseDefinitionId } from "../../../../../workflow-definitions.get.js";

/**
 * Shared pieces of the six endpoint-management routes. No default export, so
 * this is a module inside routes/ rather than a route itself.
 */

/**
 * What the editor renders in place of the secret. A constant: any mask derived
 * from the stored value (a prefix, a length, a checksum) would leak a little of
 * it on every page load, and there is nothing an operator can do with a partial
 * secret anyway. Revealing it is its own audited route.
 */
export const MASKED_WEBHOOK_SECRET = `whsec_${"•".repeat(64)}`;

export interface WebhookEndpointTarget {
  definitionId: number;
  nodeId: string;
}

export function parseWebhookEndpointTarget(event: H3Event): WebhookEndpointTarget {
  const definitionId = parseDefinitionId(event);
  const nodeId = getRouterParam(event, "nodeId")?.trim();
  if (!nodeId) {
    throw createError({ statusCode: 404, statusMessage: "Unknown trigger" });
  }
  return { definitionId, nodeId };
}

/** Reads are open to every dashboard member; every mutation below rotates,
 *  reveals or revokes a credential, so they share the cockpit mutation role. */
export async function requireWebhookActor(event: H3Event, mutation: boolean) {
  const actor = await requireDashboardActor(event);
  if (mutation && !canDispatchWorkflowRuns(actor.role)) {
    throw createError({ statusCode: 403, statusMessage: "Forbidden" });
  }
  return actor;
}

/** Without a key nothing can be decrypted or minted, which is a deployment
 *  configuration problem rather than anything the caller did wrong. */
export function requireWebhookEncryptionKey(): string {
  const keyHex = env.WEBHOOK_TRIGGER_ENCRYPTION_KEY;
  if (!keyHex) {
    throw createError({
      statusCode: 503,
      statusMessage: "Webhook trigger encryption is not configured",
    });
  }
  return keyHex;
}

export async function requireWebhookEndpoint(
  db: Db,
  target: WebhookEndpointTarget,
): Promise<WebhookEndpointRow> {
  const endpoint = await getWebhookEndpointForNode(db, target.definitionId, target.nodeId);
  if (!endpoint) {
    throw createError({ statusCode: 404, statusMessage: "Unknown webhook endpoint" });
  }
  return endpoint;
}

/**
 * The endpoint's node in the definition's live deployed head, with the version
 * it belongs to. Null unless the definition is enabled, not archived, has a
 * deployed head, and that head declares this webhook node: anything short of all
 * four is the "authored but not live" case, which must never mint a URL a sender
 * could rely on nor let a dead endpoint be tested green.
 */
export async function findDeployedWebhookNode(
  db: Db,
  target: WebhookEndpointTarget,
): Promise<{ definitionVersion: number; node: MintableWebhookNode } | null> {
  const definition = await getWorkflowDefinition(db, target.definitionId);
  if (!definition || !definition.enabled || definition.archivedAt) return null;
  const head = await getDeployedWorkflowDefinitionVersion(db, target.definitionId);
  if (!head) return null;
  // A trigger_webhook node only exists in a v2 graph, so matching the type is
  // also what rules out a v1 node that happens to share the id.
  const nodes = head.definition.nodes as readonly {
    id: string;
    type: string;
    configuration?: Record<string, unknown>;
  }[];
  const node = nodes.find((n) => n.id === target.nodeId && n.type === "trigger_webhook");
  if (!node) return null;
  return {
    definitionVersion: head.version,
    node: { id: node.id, type: "trigger_webhook", configuration: node.configuration ?? {} },
  };
}

/**
 * The endpoint as the editor may see it. The URL is built from the origin this
 * request arrived on, so a preview deployment shows its own host instead of a
 * baked-in one, and the delivery path it names is the route that serves it.
 */
export async function serializeWebhookEndpointConfig(
  db: Db,
  event: H3Event,
  endpoint: WebhookEndpointRow,
  now: Date = new Date(),
): Promise<WebhookEndpointConfig> {
  const hasPendingRotation = Boolean(
    endpoint.previousSecretCiphertext &&
      endpoint.previousExpiresAt &&
      endpoint.previousExpiresAt > now,
  );
  const authScheme = endpoint.authScheme as WebhookAuthScheme;
  return {
    endpointId: endpoint.id,
    url: `${getRequestURL(event).origin}/webhooks/custom/${endpoint.id}`,
    authScheme,
    headerName: resolveWebhookHeaderName(authScheme, endpoint.headerName),
    requireTimestamp: endpoint.requireTimestamp,
    timestampHeader: resolveWebhookTimestampHeaderName(endpoint.timestampHeader),
    timestampToleranceSeconds: endpoint.timestampToleranceSeconds,
    maskedSecret: MASKED_WEBHOOK_SECRET,
    hasPendingRotation,
    previousExpiresAt: hasPendingRotation
      ? endpoint.previousExpiresAt!.toISOString()
      : null,
    rejectionsToday: await getWebhookRejectionsToday(db, endpoint.id, now),
  };
}

/** Who did what to which endpoint. Never the secret, and never the payload of
 *  anything the endpoint received. */
export function auditWebhookAction(
  actorId: string,
  endpointId: string,
  action: "minted" | "rotated" | "revealed" | "revoked" | "unrevoked" | "tested",
): void {
  logger.info({ actorId, endpointId, action }, "webhook_endpoint_action");
}
