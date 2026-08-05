import type { WebhookEndpointRevivalResponse } from "@shared/contracts";
import { createError, defineEventHandler } from "h3";
import { getDb } from "../../../../../../../../db/client.js";
import { toHttpError } from "../../../../../../../../lib/auth/request-context.js";
import {
  getWebhookEndpointById,
  unrevokeWebhookEndpoint,
} from "../../../../../../../../webhook-trigger/endpoint-store.js";
import {
  auditWebhookAction,
  parseWebhookEndpointTarget,
  requireWebhookActor,
  requireWebhookEncryptionKey,
  requireWebhookEndpoint,
} from "./endpoint-route.js";

/**
 * Bring a revoked endpoint back on a brand new secret.
 *
 * The store would happily run this against a live endpoint, which would silently
 * replace a working secret with no rotation window and no warning, so the route
 * refuses it: reviving is only meaningful for something that is out of service.
 * A live endpoint's secret is replaced through rotate, which keeps the old one
 * accepted while the sender is updated.
 */
export default defineEventHandler(
  async (event): Promise<WebhookEndpointRevivalResponse | undefined> => {
    try {
      const actor = await requireWebhookActor(event, true);
      const target = parseWebhookEndpointTarget(event);
      const keyHex = requireWebhookEncryptionKey();
      const db = getDb();
      const endpoint = await requireWebhookEndpoint(db, target);
      if (!endpoint.revokedAt) {
        throw createError({
          statusCode: 409,
          statusMessage: "Endpoint is not revoked",
        });
      }

      const revived = await unrevokeWebhookEndpoint(db, keyHex, endpoint.id);
      if (!revived) {
        // The revival only touches a still-revoked row. Our pre-read saw one, so
        // a null means the row changed underneath us: revived by a concurrent
        // caller (409) or its definition was archived away (404).
        const stillThere = await getWebhookEndpointById(db, endpoint.id);
        throw createError(
          stillThere
            ? { statusCode: 409, statusMessage: "Endpoint is not revoked" }
            : { statusCode: 404, statusMessage: "Unknown webhook endpoint" },
        );
      }

      auditWebhookAction(actor.userId, revived.endpointId, "unrevoked");
      return { endpointId: revived.endpointId, secret: revived.secret };
    } catch (error) {
      toHttpError(error);
    }
  },
);
