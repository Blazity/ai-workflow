/**
 * Today's refusals for one trigger node, as the editor's trigger panels show
 * them.
 *
 * Both counters read a ledger another cluster owns, and both reach it through
 * that cluster's interface, which carries the dispatcher and with it the engine
 * graph. They sit apart from the schedule and endpoint readers for exactly that
 * reason: a panel that only reads a schedule row or an endpoint's state must
 * not pull the dispatcher into the request that renders it.
 */
import type { WebhookRejectionSummaryEntry } from "@shared/contracts";
import type { ScheduleTarget } from "./trigger-schedules.js";
import {
  readConnectedTriggerRejectionsToday,
  readConnectedWebhookRejectionsToday,
} from "./policy-operations.js";

/** Today's dispatch-time rejections for one trigger node, grouped by reason,
 *  worst first. The counters are keyed by the definition id as a string, which
 *  is the shape every automatic trigger type writes. */
export function readTriggerRejectionsToday(target: ScheduleTarget, now: Date) {
  return readConnectedTriggerRejectionsToday(
    { definitionId: String(target.definitionId), nodeId: target.nodeId },
    now,
  );
}

/** Today's pre-dispatch refusals for one endpoint, grouped by reason. */
export function webhookRejectionsToday(
  endpointId: string,
  now: Date,
): Promise<WebhookRejectionSummaryEntry[]> {
  return readConnectedWebhookRejectionsToday(endpointId, now);
}
