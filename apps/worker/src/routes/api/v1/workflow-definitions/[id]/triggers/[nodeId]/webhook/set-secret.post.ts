import type { WebhookSetSecretResponse } from "@shared/contracts";
import { parseRequestBody, webhookSetSecretBodySchema } from "@shared/contracts";
import { createError, defineEventHandler, readBody } from "h3";
import { toHttpError } from "../../../../../../../../services/auth/request-context.js";
import {
  importWebhookSecret,
} from "../../../../../../../../services/workflow-definitions/trigger-webhooks.js";
import {
  parseWebhookEndpointTarget,
  requireWebhookActor,
  requireWebhookEncryptionKey,
  requireWebhookEndpoint,
  serializeWebhookEndpointConfig,
} from "./endpoint-route.js";

/**
 * Set the signing secret to a value the sender itself generated, for a system
 * that signs with its own secret (Sentry's Internal Integration Client Secret)
 * rather than one this endpoint minted.
 *
 * A hard replace with no dual-accept window: the old minted secret stops working
 * immediately, which is the operator's explicit intent when importing. Refused on
 * a revoked endpoint (409), mirroring unrevoke's stance that a taken-out-of-
 * service endpoint is not something you reconfigure in place. The imported value
 * is never logged, never echoed: the response is only the refreshed masked config.
 */
export default defineEventHandler(
  async (event): Promise<WebhookSetSecretResponse | undefined> => {
    try {
      const actor = await requireWebhookActor(event, true);
      const target = parseWebhookEndpointTarget(event);
      const keyHex = requireWebhookEncryptionKey();
      const endpoint = await requireWebhookEndpoint(target);
      if (endpoint.revokedAt) {
        throw createError({ statusCode: 409, statusMessage: "Endpoint is revoked" });
      }
      const parsed = parseRequestBody(
        webhookSetSecretBodySchema,
        (await readBody(event).catch(() => null)) ?? {},
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }
      // A non-string becomes the empty string so the store, not this route,
      // says what a secret has to look like.
      const secret = typeof parsed.value.secret === "string" ? parsed.value.secret : "";

      const updated = await importWebhookSecret(keyHex, endpoint.id, secret, actor.userId);
      if (!updated.ok) {
        throw updated.reason === "invalid"
          ? createError({ statusCode: 400, statusMessage: updated.message })
          : createError({ statusCode: 404, statusMessage: "Unknown webhook endpoint" });
      }

      return await serializeWebhookEndpointConfig(event, updated.endpoint);
    } catch (error) {
      toHttpError(error);
    }
  },
);
