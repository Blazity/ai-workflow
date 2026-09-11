import type { WebhookAuthScheme, WebhookEndpointConfig } from "@shared/contracts";
import {
  createError,
  getRequestURL,
  getRouterParam,
  type H3Event,
} from "h3";
import {
  requireDashboardActor,
} from "../../../../../../../../services/auth/request-context.js";
import {
  canDispatchWorkflowRuns,
} from "../../../../../../../../services/auth/roles.js";
import {
  webhookTriggerEncryptionKey,
} from "../../../../../../../../services/settings/integration-settings.js";
import {
  resolveWebhookHeaderName,
  resolveWebhookTimestampHeaderName,
} from "../../../../../../../../services/webhook-trigger/verify.js";
import {
  webhookRejectionsToday,
} from "../../../../../../../../services/workflow-definitions/trigger-rejection-counts.js";
import {
  findWebhookEndpoint,
} from "../../../../../../../../services/workflow-definitions/trigger-webhooks.js";
import type {
  WebhookEndpointTarget,
} from "../../../../../../../../services/workflow-definitions/webhook-endpoint-nodes.js";
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

export type { WebhookEndpointTarget };

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
  const keyHex = webhookTriggerEncryptionKey();
  if (!keyHex) {
    throw createError({
      statusCode: 503,
      statusMessage: "Webhook trigger encryption is not configured",
    });
  }
  return keyHex;
}

export async function requireWebhookEndpoint(target: WebhookEndpointTarget) {
  const endpoint = await findWebhookEndpoint(target);
  if (!endpoint) {
    throw createError({ statusCode: 404, statusMessage: "Unknown webhook endpoint" });
  }
  return endpoint;
}

/**
 * The endpoint as the editor may see it. The URL is built from the origin this
 * request arrived on, so a preview deployment shows its own host instead of a
 * baked-in one, and the delivery path it names is the route that serves it.
 */
export async function serializeWebhookEndpointConfig(
  event: H3Event,
  endpoint: Awaited<ReturnType<typeof requireWebhookEndpoint>>,
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
    rejectionsToday: await webhookRejectionsToday(endpoint.id, now),
  };
}
