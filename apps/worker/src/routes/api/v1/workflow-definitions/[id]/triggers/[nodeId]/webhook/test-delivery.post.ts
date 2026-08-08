import { randomUUID } from "node:crypto";
import type {
  JsonValue,
  WebhookTestDeliveryResponse,
} from "@shared/contracts";
import { createError, defineEventHandler, readBody } from "h3";
import { getDb } from "../../../../../../../../db/client.js";
import { toHttpError } from "../../../../../../../../lib/auth/request-context.js";
import { webhookSubjectKey } from "../../../../../../../../lib/subject-key.js";
import {
  acceptWebhookDelivery,
  completeWebhookDelivery,
} from "../../../../../../../../webhook-trigger/delivery-store.js";
import {
  mapWebhookPayload,
  type WebhookMappingConfig,
} from "../../../../../../../../webhook-trigger/payload-mapping.js";
import { getEnabledDeployedDefinition } from "../../../../../../../../workflow-definition/store.js";
import { WEBHOOK_MAX_BODY_BYTES } from "../../../../../../../webhooks/custom/[endpointId].post.js";
import {
  auditWebhookAction,
  findDeployedWebhookNode,
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
      const db = getDb();
      const endpoint = await requireWebhookEndpoint(db, target);
      if (endpoint.revokedAt) {
        throw createError({ statusCode: 409, statusMessage: "Endpoint is revoked" });
      }

      const body = await readBody<{ payload?: JsonValue } | null>(event).catch(() => null);
      if (!body || typeof body !== "object" || !("payload" in body)) {
        throw createError({ statusCode: 400, statusMessage: "payload is required" });
      }
      const payload = body.payload as JsonValue;
      // The same size ceiling the public delivery route enforces, so a probe
      // cannot green-light a payload a real delivery would refuse with 413.
      if (Buffer.byteLength(JSON.stringify(payload) ?? "", "utf8") > WEBHOOK_MAX_BODY_BYTES) {
        throw createError({ statusCode: 413, statusMessage: "payload_too_large" });
      }

      // The log row pins a definition version, and the version is also where the
      // mappings live. findDeployedWebhookNode also gates enabled + not archived,
      // so a disabled or draft definition has nothing to test against.
      const deployed = await findDeployedWebhookNode(db, target);
      if (!deployed) {
        throw createError({
          statusCode: 409,
          statusMessage: "Deploy the definition before testing this endpoint",
        });
      }

      // A live delivery to this endpoint is refused unless this definition is
      // enabled with a readable deployed head, so the probe must be too.
      const live = await getEnabledDeployedDefinition(db, target.definitionId);
      if (!live || !live.current) {
        throw createError({
          statusCode: 409,
          statusMessage: "This definition is not the enabled webhook owner",
        });
      }

      const mapped = mapWebhookPayload(
        deployed.node.configuration as WebhookMappingConfig,
        payload,
      );
      const deliveryId = `test:${randomUUID()}`;
      await acceptWebhookDelivery(db, {
        endpointId: endpoint.id,
        deliveryId,
        // Its own subject too, so a probe never queues behind (or ahead of) real
        // traffic about the same external subject.
        subjectKey: webhookSubjectKey(endpoint.id, deliveryId),
        definitionId: target.definitionId,
        definitionVersion: deployed.definitionVersion,
        nodeId: target.nodeId,
        entry: mapped.entry,
        verifiedWith: null,
      });
      await completeWebhookDelivery(db, endpoint.id, deliveryId, {
        outcome: "test",
        reason: null,
        runId: null,
        verifiedWith: null,
      });

      auditWebhookAction(actor.userId, endpoint.id, "tested");
      return {
        outcome: "test",
        reason: null,
        runId: null,
        deliveryId,
        entry: mapped.entry,
        subjectId: mapped.subjectId,
      };
    } catch (error) {
      toHttpError(error);
    }
  },
);
