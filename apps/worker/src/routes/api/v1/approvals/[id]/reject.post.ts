import { createError, defineEventHandler, getRouterParam } from "h3";
import type { ApprovalDecisionResponse } from "@shared/contracts";
import { requireDashboardActor } from "../../../../../services/auth/request-context.js";
import {
  rejectApproval,
} from "../../../../../services/approvals/approval-decisions.js";
import { toApprovalHttpError } from "../../approvals.get.js";

export default defineEventHandler(async (event): Promise<ApprovalDecisionResponse | undefined> => {
  try {
    // Who may decide is the service's question (canApproveWorkflowPlans), so
    // this route and the MCP tools refuse the same people with one rule.
    const actor = await requireDashboardActor(event);
    const id = getRouterParam(event, "id");
    if (!id) throw createError({ statusCode: 404, statusMessage: "Unknown approval" });

    const outcome = await rejectApproval(id, { userId: actor.userId, role: actor.role });
    switch (outcome.kind) {
      case "unknown_approval":
        throw createError({ statusCode: 404, statusMessage: "Unknown approval" });
      case "already_decided":
        throw createError({ statusCode: 409, statusMessage: "already_decided" });
      case "decided":
        return { approval: outcome.approval, runId: outcome.runId };
    }
  } catch (error) {
    toApprovalHttpError(error);
  }
});
