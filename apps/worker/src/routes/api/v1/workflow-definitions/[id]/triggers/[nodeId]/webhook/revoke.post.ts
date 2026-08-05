import type { WebhookRevokeResponse } from "@shared/contracts";
import { createError, defineEventHandler } from "h3";
import { getDb } from "../../../../../../../../db/client.js";
import { toHttpError } from "../../../../../../../../lib/auth/request-context.js";
import {
  getWebhookEndpointById,
  revokeWebhookEndpoint,
} from "../../../../../../../../webhook-trigger/endpoint-store.js";
import {
  auditWebhookAction,
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
      const db = getDb();
      const endpoint = await requireWebhookEndpoint(db, target);

      await revokeWebhookEndpoint(db, endpoint.id);
      // Re-read: the revocation instant is the database clock's, and an endpoint
      // that was already revoked keeps its original one.
      const revoked = await getWebhookEndpointById(db, endpoint.id);
      if (!revoked?.revokedAt) {
        throw createError({ statusCode: 404, statusMessage: "Unknown webhook endpoint" });
      }

      auditWebhookAction(actor.userId, endpoint.id, "revoked");
      return { endpointId: endpoint.id, revokedAt: revoked.revokedAt.toISOString() };
    } catch (error) {
      toHttpError(error);
    }
  },
);
