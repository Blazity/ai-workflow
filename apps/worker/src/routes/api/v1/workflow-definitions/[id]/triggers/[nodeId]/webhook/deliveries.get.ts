import type { WebhookDeliveriesResponse } from "@shared/contracts";
import { defineEventHandler } from "h3";
import { toHttpError } from "../../../../../../../../services/auth/request-context.js";
import {
  listWebhookEndpointDeliveries,
} from "../../../../../../../../services/workflow-definitions/trigger-webhooks.js";
import {
  parseWebhookEndpointTarget,
  requireWebhookActor,
  requireWebhookEndpoint,
} from "./endpoint-route.js";

/** Recent deliveries for one endpoint, newest first. Carries no payload and no
 *  signature: only what happened to each delivery and which secret authenticated
 *  it, so a rotation window can be watched to completion. */
export default defineEventHandler(
  async (event): Promise<WebhookDeliveriesResponse | undefined> => {
    try {
      await requireWebhookActor(event, false);
      const target = parseWebhookEndpointTarget(event);
      const endpoint = await requireWebhookEndpoint(target);

      const deliveries = await listWebhookEndpointDeliveries(endpoint.id);
      return {
        deliveries: deliveries.map((delivery) => ({
          ...delivery,
          receivedAt: delivery.receivedAt.toISOString(),
        })),
      };
    } catch (error) {
      toHttpError(error);
    }
  },
);
