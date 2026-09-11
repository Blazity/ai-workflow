import type { WebhookRejectionSummaryEntry } from "@shared/contracts";
import { createError, defineEventHandler, getRouterParam } from "h3";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../../../../services/auth/request-context.js";
import {
  readTriggerRejectionsToday,
} from "../../../../../../../services/workflow-definitions/trigger-schedules.js";
import { parseDefinitionId } from "../../../../workflow-definitions.get.js";

export interface TriggerRejectionsResponse {
  rejectionsToday: WebhookRejectionSummaryEntry[];
}

/**
 * Today's dispatch-time rejections for one trigger node, grouped by reason,
 * worst first. Reads trigger_rejection_counters, the per-node table every
 * automatic trigger type (ticket, PR, schedule, webhook) writes when its rate
 * limit refuses a start — the webhook endpoint counters only cover refusals
 * before dispatch.
 */
export default defineEventHandler(
  async (event): Promise<TriggerRejectionsResponse | undefined> => {
    try {
      await requireDashboardActor(event);
      const definitionId = parseDefinitionId(event);
      const nodeId = getRouterParam(event, "nodeId")?.trim();
      if (!nodeId) {
        throw createError({ statusCode: 404, statusMessage: "Unknown trigger" });
      }
      const rejectionsToday = await readTriggerRejectionsToday(
        { definitionId, nodeId },
        new Date(),
      );
      return { rejectionsToday };
    } catch (error) {
      toHttpError(error);
    }
  },
);
