import type { McpToolDependencies } from "../contracts.js";

/**
 * The trigger nodes of a deployed graph that cannot be shown able to fire right
 * now. The one rule behind workflows.publish's "not verified able to fire" and
 * workflows.list's `armed`, so the two can never disagree about the same node.
 *
 * Deliberately a check and not a deduction: for two trigger types the row that
 * lets them fire lives outside the definition, and a stored `enabled` flag or a
 * successful deploy does not establish that it is there and usable.
 *
 *   - a schedule fires from a row in workflow_schedules, and the evaluator skips a
 *     paused or revoked one (schedule-store.ts, listEvaluableSchedules). paused_at
 *     survives a redeploy on purpose, so "published" and "will fire" are genuinely
 *     different questions here;
 *   - a webhook delivery authenticates against an endpoint row. The deployment gate
 *     already refuses a webhook trigger when webhook encryption is unconfigured, so
 *     what is left for this check is a mint that failed (it is best-effort,
 *     services/workflow-definitions/live-trigger-sync.ts) and an endpoint an
 *     operator revoked;
 *   - every other trigger type routes through the binding table, which enabling a
 *     deployed definition claims in the same statement that flips the switch
 *     (db/repositories/definitions/atomic.ts), so an enabled definition has it.
 *
 * A disabled definition reaches none of them, so all of its trigger nodes are
 * dormant. Callers pass only the triggers of a DEPLOYED v2 graph: a definition
 * with nothing deployed has no trigger to arm, whatever its switch says.
 */
export async function dormantTriggerNodeIds(
  services: Pick<
    McpToolDependencies["services"],
    "listSchedulesForDefinition" | "getWebhookEndpointForNode"
  >,
  definitionId: number,
  triggers: readonly { id: string; type: string }[],
  enabled: boolean,
): Promise<string[]> {
  if (!enabled) return triggers.map((node) => node.id);

  const dormant: string[] = [];
  const scheduleRows = triggers.some((node) => node.type === "trigger_schedule")
    ? await services.listSchedulesForDefinition(definitionId)
    : [];
  for (const node of triggers) {
    if (node.type === "trigger_schedule") {
      const row = scheduleRows.find((schedule) => schedule.nodeId === node.id);
      if (!row || row.pausedAt !== null || row.revokedAt !== null) dormant.push(node.id);
      continue;
    }
    if (node.type === "trigger_webhook") {
      const endpoint = await services.getWebhookEndpointForNode(definitionId, node.id);
      if (!endpoint || endpoint.revokedAt !== null) dormant.push(node.id);
    }
  }
  return dormant;
}
