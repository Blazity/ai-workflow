import type { WebhookEndpointRevivalResponse } from "@shared/contracts";
import { createError, defineEventHandler } from "h3";
import { toHttpError } from "../../../../../../../../services/auth/request-context.js";
import {
  reviveWebhookEndpoint,
} from "../../../../../../../../services/workflow-definitions/trigger-webhooks.js";
import {
  parseWebhookEndpointTarget,
  requireWebhookActor,
  requireWebhookEncryptionKey,
  requireWebhookEndpoint,
} from "./endpoint-route.js";

/**
 * Bring a revoked endpoint back on a brand new secret.
 *
 * The store would happily run this against a live endpoint, which would silently
 * replace a working secret with no rotation window and no warning, so it is
 * refused: reviving is only meaningful for something that is out of service.
 * A live endpoint's secret is replaced through rotate, which keeps the old one
 * accepted while the sender is updated.
 */
export default defineEventHandler(
  async (event): Promise<WebhookEndpointRevivalResponse | undefined> => {
    try {
      const actor = await requireWebhookActor(event, true);
      const target = parseWebhookEndpointTarget(event);
      const keyHex = requireWebhookEncryptionKey();
      const endpoint = await requireWebhookEndpoint(target);

      const revived = await reviveWebhookEndpoint(keyHex, endpoint, actor.userId);
      if (!revived.ok) {
        throw createError(
          revived.reason === "not_revoked"
            ? { statusCode: 409, statusMessage: "Endpoint is not revoked" }
            : { statusCode: 404, statusMessage: "Unknown webhook endpoint" },
        );
      }

      return { endpointId: revived.endpointId, secret: revived.secret };
    } catch (error) {
      toHttpError(error);
    }
  },
);
