import type { WebhookEndpointConfigResponse } from "@shared/contracts";
import { defineEventHandler } from "h3";
import { env } from "../../../../../../../../../env.js";
import { getDb, type Db } from "../../../../../../../../db/client.js";
import { toHttpError } from "../../../../../../../../lib/auth/request-context.js";
import { canDispatchWorkflowRuns } from "../../../../../../../../lib/auth/roles.js";
import {
  getWebhookEndpointForNode,
  mintWebhookEndpointsForDefinition,
  type WebhookEndpointRow,
} from "../../../../../../../../webhook-trigger/endpoint-store.js";
import { getEnabledWorkflowDefinitionForTrigger } from "../../../../../../../../workflow-definition/store.js";
import {
  auditWebhookAction,
  findDeployedWebhookNode,
  parseWebhookEndpointTarget,
  requireWebhookActor,
  serializeWebhookEndpointConfig,
  type WebhookEndpointTarget,
} from "./endpoint-route.js";

/**
 * Everything the editor shows for one webhook trigger node.
 *
 * Reading also heals: an endpoint is normally minted when a definition is
 * deployed or enabled, but a definition deployed before this feature existed (or
 * one whose best-effort mint failed) has a live webhook node and no endpoint
 * row. Minting here means opening the node's panel repairs it. The heal is a
 * write, so it is gated on the mutation role and audited: a member GET with no
 * row reads await_deploy instead, and an owner/admin opening the panel is what
 * backfills a pre-existing definition.
 */
export default defineEventHandler(
  async (event): Promise<WebhookEndpointConfigResponse | undefined> => {
    try {
      const actor = await requireWebhookActor(event, false);
      const target = parseWebhookEndpointTarget(event);
      const db = getDb();

      const keyHex = env.WEBHOOK_TRIGGER_ENCRYPTION_KEY;
      if (!keyHex) return { state: "unconfigured", endpoint: null };

      let endpoint = await getWebhookEndpointForNode(db, target.definitionId, target.nodeId);
      if (!endpoint && canDispatchWorkflowRuns(actor.role)) {
        endpoint = await mintMissingEndpoint(db, keyHex, target);
        if (endpoint) auditWebhookAction(actor.userId, endpoint.id, "minted");
      }
      if (!endpoint) return { state: "await_deploy", endpoint: null };

      if (endpoint.revokedAt) {
        return {
          state: "revoked",
          endpoint: await serializeWebhookEndpointConfig(db, event, endpoint),
        };
      }

      // Present and live, but is THIS definition the one currently receiving
      // deliveries? Another enabled definition may own the webhook trigger, in
      // which case this endpoint exists but every delivery to it is refused.
      const owner = await getEnabledWorkflowDefinitionForTrigger(db, "trigger_webhook");
      const isOwner = owner?.definition.id === target.definitionId;
      return {
        state: isOwner ? "active" : "inactive",
        endpoint: await serializeWebhookEndpointConfig(db, event, endpoint),
      };
    } catch (error) {
      toHttpError(error);
    }
  },
);

/** Mint only for a node that is genuinely live (enabled, not archived, deployed
 *  head declares it): findDeployedWebhookNode enforces all three, so a draft or a
 *  disabled definition never gets a URL a sender could rely on. */
async function mintMissingEndpoint(
  db: Db,
  keyHex: string,
  target: WebhookEndpointTarget,
): Promise<WebhookEndpointRow | null> {
  const deployed = await findDeployedWebhookNode(db, target);
  if (!deployed) return null;

  await mintWebhookEndpointsForDefinition(db, keyHex, {
    definitionId: target.definitionId,
    nodes: [deployed.node],
  });
  return getWebhookEndpointForNode(db, target.definitionId, target.nodeId);
}
