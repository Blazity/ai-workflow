import type { WebhookEndpointConfigResponse } from "@shared/contracts";
import { defineEventHandler } from "h3";
import { toHttpError } from "../../../../../../../../services/auth/request-context.js";
import {
  canDispatchWorkflowRuns,
} from "../../../../../../../../services/auth/roles.js";
import {
  webhookTriggerEncryptionKey,
} from "../../../../../../../../services/settings/integration-settings.js";
import {
  readWebhookEndpointState,
} from "../../../../../../../../services/workflow-definitions/trigger-webhooks.js";
import {
  parseWebhookEndpointTarget,
  requireWebhookActor,
  serializeWebhookEndpointConfig,
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

      const read = await readWebhookEndpointState(target, {
        actorId: actor.userId,
        mayMint: canDispatchWorkflowRuns(actor.role),
        encryptionKey: webhookTriggerEncryptionKey(),
      });
      if (!read.endpoint) return { state: read.state, endpoint: null };
      return {
        state: read.state,
        endpoint: await serializeWebhookEndpointConfig(event, read.endpoint),
      };
    } catch (error) {
      toHttpError(error);
    }
  },
);
