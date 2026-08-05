import type { WebhookDeliveriesResponse } from "@shared/contracts";
import { defineEventHandler } from "h3";
import { getDb } from "../../../../../../../../db/client.js";
import { toHttpError } from "../../../../../../../../lib/auth/request-context.js";
import { listRecentWebhookDeliveries } from "../../../../../../../../webhook-trigger/delivery-store.js";
import {
  parseWebhookEndpointTarget,
  requireWebhookActor,
  requireWebhookEndpoint,
} from "./endpoint-route.js";

/** How much history the endpoint panel shows. Enough to see a pattern, small
 *  enough to stay one query and one render. */
const DELIVERY_LOG_LIMIT = 50;

/** Recent deliveries for one endpoint, newest first. Carries no payload and no
 *  signature: only what happened to each delivery and which secret authenticated
 *  it, so a rotation window can be watched to completion. */
export default defineEventHandler(
  async (event): Promise<WebhookDeliveriesResponse | undefined> => {
    try {
      await requireWebhookActor(event, false);
      const target = parseWebhookEndpointTarget(event);
      const db = getDb();
      const endpoint = await requireWebhookEndpoint(db, target);

      const deliveries = await listRecentWebhookDeliveries(
        db,
        endpoint.id,
        DELIVERY_LOG_LIMIT,
      );
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
