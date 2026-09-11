/**
 * Best-effort convergence for the two self-routed trigger stores. Definition
 * persistence deliberately does not know configuration, endpoint secrets or
 * schedule rows; after a definition becomes live this service reconciles them.
 */
import type { Db } from "../../db/types.js";
import { createDefinitionsRepository } from "../../db/repositories/definitions.js";
import { logger } from "../../infra/logger.js";
import { getWorkflowDefinition } from "../../db/repositories/definitions.js";
import {
  getConnectedWorkflowDefinition,
  revokeConnectedScheduleAndCancelWaiting,
} from "../../db/repositories/definitions/connected.js";
import {
  listConnectedSchedulesForDefinition,
  mintConnectedSchedulesForLiveHead,
} from "../../db/repositories/schedule-triggers.js";
import { mintConnectedWebhookEndpointsForDefinition } from "../../db/repositories/webhook-trigger-endpoints.js";
import { listSchedulesForDefinition, mintSchedulesForLiveHead } from "../../schedule-trigger/schedule-store.js";
import { mintWebhookEndpointsForDefinition } from "../../webhook-trigger/endpoint-store.js";
import { webhookTriggerEncryptionKey } from "../settings/index.js";
import {
  readConnectedDeployedWorkflowDefinitionVersion,
  readDeployedWorkflowDefinitionVersion,
} from "../../engine/stored-definition-reads.js";

/** Keep webhook endpoints and schedules aligned with an enabled deployed head.
 * A failure must not turn a successful authoring transition into a failed one:
 * opening a webhook panel and the next schedule tick both retry convergence. */
export async function syncLiveDefinitionTriggers(
  db: Db,
  definitionId: number,
): Promise<void> {
  try {
    const definition = await getWorkflowDefinition(db, definitionId);
    if (!definition || definition.archivedAt !== null) return;
    const head = await readDeployedWorkflowDefinitionVersion(db, definitionId);
    if (!head || head.schema !== "v2") return;

    try {
      const encryptionKey = webhookTriggerEncryptionKey();
      if (encryptionKey) {
        await mintWebhookEndpointsForDefinition(db, encryptionKey, {
          definitionId,
          nodes: head.definition.nodes,
        });
      }
    } catch (error) {
      logger.warn(
        { definitionId, err: error instanceof Error ? error.message : String(error) },
        "webhook_endpoint_mint_failed",
      );
    }

    if (!definition.enabled) return;

    try {
      await mintSchedulesForLiveHead(db, { definitionId, nodes: head.definition.nodes });
      const liveNodeIds = new Set(
        head.definition.nodes
          .filter((node) => node.type === "trigger_schedule")
          .map((node) => node.id),
      );
      for (const row of await listSchedulesForDefinition(db, definitionId)) {
        if (liveNodeIds.has(row.nodeId)) continue;
        await createDefinitionsRepository(db).revokeScheduleAndCancelWaiting(row.id);
      }
    } catch (error) {
      logger.warn(
        { definitionId, err: error instanceof Error ? error.message : String(error) },
        "workflow_schedule_sync_failed",
      );
    }
  } catch (error) {
    logger.warn(
      { definitionId, err: error instanceof Error ? error.message : String(error) },
      "live_trigger_sync_failed",
    );
  }
}

/** Process-bound equivalent used by route-facing definition operations. */
export async function syncConnectedLiveDefinitionTriggers(
  definitionId: number,
): Promise<void> {
  try {
    const definition = await getConnectedWorkflowDefinition(definitionId);
    if (!definition || definition.archivedAt !== null) return;
    const head = await readConnectedDeployedWorkflowDefinitionVersion(definitionId);
    if (!head || head.schema !== "v2") return;

    try {
      const encryptionKey = webhookTriggerEncryptionKey();
      if (encryptionKey) {
        await mintConnectedWebhookEndpointsForDefinition(encryptionKey, {
          definitionId,
          nodes: head.definition.nodes,
        });
      }
    } catch (error) {
      logger.warn(
        { definitionId, err: error instanceof Error ? error.message : String(error) },
        "webhook_endpoint_mint_failed",
      );
    }

    if (!definition.enabled) return;

    try {
      await mintConnectedSchedulesForLiveHead({ definitionId, nodes: head.definition.nodes });
      const liveNodeIds = new Set(
        head.definition.nodes
          .filter((node) => node.type === "trigger_schedule")
          .map((node) => node.id),
      );
      for (const row of await listConnectedSchedulesForDefinition(definitionId)) {
        if (liveNodeIds.has(row.nodeId)) continue;
        await revokeConnectedScheduleAndCancelWaiting(row.id);
      }
    } catch (error) {
      logger.warn(
        { definitionId, err: error instanceof Error ? error.message : String(error) },
        "workflow_schedule_sync_failed",
      );
    }
  } catch (error) {
    logger.warn(
      { definitionId, err: error instanceof Error ? error.message : String(error) },
      "live_trigger_sync_failed",
    );
  }
}
