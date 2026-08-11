import type { WebhookRejectionSummaryEntry } from "@shared/contracts";
import { createError, defineEventHandler, getRouterParam } from "h3";
import { getDb } from "../../../../../../../db/client.js";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../../../../lib/auth/request-context.js";
import { getTriggerRejectionsToday } from "../../../../../../../lib/trigger-rate-limit.js";
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
      const rejectionsToday = await getTriggerRejectionsToday(
        getDb(),
        { definitionId: String(definitionId), nodeId },
        new Date(),
      );
      return { rejectionsToday };
    } catch (error) {
      toHttpError(error);
    }
  },
);
