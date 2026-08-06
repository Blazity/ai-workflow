import type { WebhookSetSecretRequest, WebhookSetSecretResponse } from "@shared/contracts";
import { createError, defineEventHandler, readBody } from "h3";
import { getDb } from "../../../../../../../../db/client.js";
import { toHttpError } from "../../../../../../../../lib/auth/request-context.js";
import {
  setWebhookEndpointSecret,
  WebhookSecretInvalidError,
} from "../../../../../../../../webhook-trigger/endpoint-store.js";
import {
  auditWebhookAction,
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
      const db = getDb();
      const endpoint = await requireWebhookEndpoint(db, target);
      if (endpoint.revokedAt) {
        throw createError({ statusCode: 409, statusMessage: "Endpoint is revoked" });
      }
      const body = await readBody<WebhookSetSecretRequest | null>(event).catch(() => null);
      const secret = typeof body?.secret === "string" ? body.secret : "";

      const updated = await setWebhookEndpointSecret(db, keyHex, endpoint.id, secret).catch(
        (error: unknown) => {
          if (error instanceof WebhookSecretInvalidError) {
            throw createError({ statusCode: 400, statusMessage: error.message });
          }
          throw error;
        },
      );
      if (!updated) {
        throw createError({ statusCode: 404, statusMessage: "Unknown webhook endpoint" });
      }

      // Actor and endpoint id only: never the imported secret.
      auditWebhookAction(actor.userId, updated.id, "secret_imported");
      return await serializeWebhookEndpointConfig(db, event, updated);
    } catch (error) {
      toHttpError(error);
    }
  },
);
