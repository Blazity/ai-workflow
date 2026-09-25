import { createError, defineEventHandler, getRouterParam } from "h3";
import type { ApprovalDecisionResponse } from "@shared/contracts";
import { requireDashboardActor } from "../../../../../services/auth/request-context.js";
import {
  approveApproval,
} from "../../../../../services/approvals/approval-decisions.js";
import { getRequestSettingsSnapshot } from "../../../../../services/settings/index.js";
import { toApprovalHttpError } from "../../approvals.get.js";

export default defineEventHandler(async (event): Promise<ApprovalDecisionResponse | undefined> => {
  try {
    // Who may decide is the service's question (canApproveWorkflowPlans), so
    // this route and the MCP tools refuse the same people with one rule.
    const actor = await requireDashboardActor(event);
    const id = getRouterParam(event, "id");
    if (!id) throw createError({ statusCode: 404, statusMessage: "Unknown approval" });

    const outcome = await approveApproval(
      id,
      { userId: actor.userId, role: actor.role },
      await getRequestSettingsSnapshot(event),
    );
    switch (outcome.kind) {
      case "unknown_approval":
        throw createError({ statusCode: 404, statusMessage: "Unknown approval" });
      case "already_decided":
        throw createError({ statusCode: 409, statusMessage: "already_decided" });
      case "ticket_gone":
        throw createError({ statusCode: 410, statusMessage: "ticket_gone" });
      case "definition_gone":
        throw createError({ statusCode: 410, statusMessage: "definition_gone" });
      case "run_in_flight":
        throw createError({ statusCode: 409, statusMessage: "run_in_flight" });
      case "issue_tracker_unavailable":
        // Nothing was decided, so the same button works once there is a
        // tracker to start the run from. The sentence says where to fix it.
        throw createError({
          statusCode: outcome.retryable ? 503 : 409,
          statusMessage: outcome.message,
        });
      case "decided":
        return { approval: outcome.approval, runId: outcome.runId };
    }
  } catch (error) {
    toApprovalHttpError(error);
  }
});
