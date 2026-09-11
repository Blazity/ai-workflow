import { randomUUID } from "node:crypto";
import type {
  JsonValue,
  WebhookTestDeliveryResponse,
} from "@shared/contracts";
import { parseRequestBody, webhookTestDeliveryRequestSchema } from "@shared/contracts";
import { createError, defineEventHandler, readBody } from "h3";
import { toHttpError } from "../../../../../../../../services/auth/request-context.js";
import {
  WEBHOOK_MAX_BODY_BYTES,
} from "../../../../../../../../services/triggers/custom-webhooks/deliver.js";
import {
  runWebhookTestDelivery,
} from "../../../../../../../../services/workflow-definitions/webhook-endpoint-nodes.js";
import {
  parseWebhookEndpointTarget,
  requireWebhookActor,
  requireWebhookEncryptionKey,
  requireWebhookEndpoint,
} from "./endpoint-route.js";

/**
 * Answer "what would this endpoint make of this payload" without any of the
 * consequences of a real delivery.
 *
 * A dry run end to end: it maps the payload exactly as the delivery path would
 * and writes one log row so the operator sees the probe next to real traffic,
 * but it claims no subject, starts no run, and above all takes an identity no
 * sender can ever produce. A real delivery id is either the sender's header or a
 * digest of the body; this one is "test:" plus a UUID, so posting the same body
 * for real afterwards is still a first delivery rather than a replay of this.
 *
 * A dead endpoint must test red, not green: it is refused when revoked or when
 * its definition is not enabled+deployed, so the probe never suggests a delivery
 * would work when it would be refused at the door.
 */
export default defineEventHandler(
  async (event): Promise<WebhookTestDeliveryResponse | undefined> => {
    try {
      const actor = await requireWebhookActor(event, true);
      const target = parseWebhookEndpointTarget(event);
      requireWebhookEncryptionKey();
      const endpoint = await requireWebhookEndpoint(target);
      if (endpoint.revokedAt) {
        throw createError({ statusCode: 409, statusMessage: "Endpoint is revoked" });
      }

      const parsed = parseRequestBody(
        webhookTestDeliveryRequestSchema,
        await readBody(event).catch(() => null),
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }
      const payload = parsed.value.payload as JsonValue;
      // The same size ceiling the public delivery route enforces, so a probe
      // cannot green-light a payload a real delivery would refuse with 413.
      if (Buffer.byteLength(JSON.stringify(payload) ?? "", "utf8") > WEBHOOK_MAX_BODY_BYTES) {
        throw createError({ statusCode: 413, statusMessage: "payload_too_large" });
      }

      const result = await runWebhookTestDelivery({
        target,
        endpointId: endpoint.id,
        payload,
        deliveryId: `test:${randomUUID()}`,
        actorId: actor.userId,
      });
      if (!result.ok) {
        throw createError({
          statusCode: 409,
          statusMessage:
            result.reason === "not_deployed"
              ? "Deploy the definition before testing this endpoint"
              : "This definition is not the enabled webhook owner",
        });
      }

      return {
        outcome: "test",
        reason: null,
        runId: null,
        deliveryId: result.deliveryId,
        entry: result.entry,
        subjectId: result.subjectId,
      };
    } catch (error) {
      toHttpError(error);
    }
  },
);
