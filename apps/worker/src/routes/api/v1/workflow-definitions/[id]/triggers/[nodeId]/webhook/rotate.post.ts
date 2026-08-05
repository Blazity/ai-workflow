import type { WebhookRotateResponse } from "@shared/contracts";
import { createError, defineEventHandler, readBody } from "h3";
import { getDb } from "../../../../../../../../db/client.js";
import { toHttpError } from "../../../../../../../../lib/auth/request-context.js";
import {
  rotateWebhookEndpointSecret,
  WebhookRotationInFlightError,
} from "../../../../../../../../webhook-trigger/endpoint-store.js";
import {
  auditWebhookAction,
  parseWebhookEndpointTarget,
  requireWebhookActor,
  requireWebhookEncryptionKey,
  requireWebhookEndpoint,
} from "./endpoint-route.js";

/**
 * Replace the signing secret and return the new one, once.
 *
 * A rotation keeps the replaced secret valid for a fixed window so the sender
 * can be updated without a failed delivery. Rotating again while that window is
 * open would evict a secret the first rotation is still promising to accept, so
 * it is refused with 409 until the operator says `force` (the leaked-secret
 * case, where the old one must die now).
 */
export default defineEventHandler(
  async (event): Promise<WebhookRotateResponse | undefined> => {
    try {
      const actor = await requireWebhookActor(event, true);
      const target = parseWebhookEndpointTarget(event);
      const keyHex = requireWebhookEncryptionKey();
      const db = getDb();
      const endpoint = await requireWebhookEndpoint(db, target);
      const body = await readBody<{ force?: unknown } | null>(event).catch(() => null);

      const rotated = await rotateWebhookEndpointSecret(db, keyHex, endpoint.id, {
        force: body?.force === true,
      }).catch((error: unknown) => {
        if (error instanceof WebhookRotationInFlightError) {
          throw createError({
            statusCode: 409,
            statusMessage: "A replaced secret is still accepted",
            data: { previousExpiresAt: error.previousExpiresAt.toISOString() },
          });
        }
        throw error;
      });
      if (!rotated) {
        throw createError({ statusCode: 404, statusMessage: "Unknown webhook endpoint" });
      }

      auditWebhookAction(actor.userId, rotated.endpointId, "rotated");
      return {
        endpointId: rotated.endpointId,
        secret: rotated.secret,
        previousExpiresAt: rotated.previousExpiresAt.toISOString(),
      };
    } catch (error) {
      toHttpError(error);
    }
  },
);
