import type { WebhookRevokeResponse } from "@shared/contracts";
import { createError, defineEventHandler } from "h3";
import { toHttpError } from "../../../../../../../../services/auth/index.js";
import { revokeWebhookEndpointForNode } from "../../../../../../../../services/workflow-definitions/index.js";
import {
  parseWebhookEndpointTarget,
  requireWebhookActor,
  requireWebhookEndpoint,
} from "./endpoint-route.js";

/**
 * Stop accepting deliveries for this endpoint, keeping its history. Terminal
 * until an operator revives it: no deploy undoes a revocation, because a
 * revocation a deploy could undo would be no revocation at all.
 *
 * Idempotent. Revoking an already revoked endpoint reports the first revocation
 * instant rather than failing, since the caller's intent is already satisfied.
 */
export default defineEventHandler(
  async (event): Promise<WebhookRevokeResponse | undefined> => {
    try {
      const actor = await requireWebhookActor(event, true);
      const target = parseWebhookEndpointTarget(event);
      const endpoint = await requireWebhookEndpoint(target);

      const revokedAt = await revokeWebhookEndpointForNode(endpoint.id, actor.userId);
      if (!revokedAt) {
        throw createError({ statusCode: 404, statusMessage: "Unknown webhook endpoint" });
      }

      return { endpointId: endpoint.id, revokedAt: revokedAt.toISOString() };
    } catch (error) {
      toHttpError(error);
    }
  },
);
