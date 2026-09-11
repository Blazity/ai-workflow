import type { WebhookRevealResponse } from "@shared/contracts";
import { createError, defineEventHandler } from "h3";
import { toHttpError } from "../../../../../../../../services/auth/request-context.js";
import {
  revealWebhookSecret,
} from "../../../../../../../../services/workflow-definitions/trigger-webhooks.js";
import {
  parseWebhookEndpointTarget,
  requireWebhookActor,
  requireWebhookEncryptionKey,
  requireWebhookEndpoint,
} from "./endpoint-route.js";

/**
 * Show the current signing secret again. A minted secret is displayed once, and
 * without this an operator who missed it would have to rotate (breaking the
 * sender) just to read it. POST rather than GET so it is never replayed by a
 * prefetch, a browser history entry, or a link.
 */
export default defineEventHandler(
  async (event): Promise<WebhookRevealResponse | undefined> => {
    try {
      const actor = await requireWebhookActor(event, true);
      const target = parseWebhookEndpointTarget(event);
      const keyHex = requireWebhookEncryptionKey();
      const endpoint = await requireWebhookEndpoint(target);

      const secret = await revealWebhookSecret(keyHex, endpoint.id, actor.userId);
      if (!secret) {
        throw createError({ statusCode: 404, statusMessage: "Unknown webhook endpoint" });
      }

      return { endpointId: endpoint.id, secret };
    } catch (error) {
      toHttpError(error);
    }
  },
);
