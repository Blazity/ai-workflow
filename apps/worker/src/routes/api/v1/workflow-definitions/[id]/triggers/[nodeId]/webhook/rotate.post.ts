import type { WebhookRotateResponse } from "@shared/contracts";
import { parseRequestBody, webhookRotateSecretRequestSchema } from "@shared/contracts";
import { createError, defineEventHandler, readBody } from "h3";
import { toHttpError } from "../../../../../../../../services/auth/index.js";
import { rotateWebhookSecret } from "../../../../../../../../services/workflow-definitions/index.js";
import {
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
      const endpoint = await requireWebhookEndpoint(target);
      const parsed = parseRequestBody(
        webhookRotateSecretRequestSchema,
        (await readBody(event).catch(() => null)) ?? {},
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }

      const rotated = await rotateWebhookSecret(keyHex, endpoint.id, {
        // Only the literal true forces: anything else leaves the window intact.
        force: parsed.value.force === true,
        actorId: actor.userId,
      });
      if (!rotated.ok) {
        throw rotated.reason === "rotation_in_flight"
          ? createError({
              statusCode: 409,
              statusMessage: "A replaced secret is still accepted",
              data: { previousExpiresAt: rotated.previousExpiresAt.toISOString() },
            })
          : createError({ statusCode: 404, statusMessage: "Unknown webhook endpoint" });
      }

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
