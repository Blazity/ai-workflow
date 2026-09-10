import { createError, defineEventHandler, getRouterParam } from "h3";
import type { ApprovalDecisionResponse } from "@shared/contracts";
import {
  canApproveWorkflowPlans,
  requireDashboardActor,
} from "../../../../../services/auth/index.js";
import { rejectApproval } from "../../../../../services/approvals/index.js";
import { toApprovalHttpError } from "../../approvals.get.js";

export default defineEventHandler(async (event): Promise<ApprovalDecisionResponse | undefined> => {
  try {
    const actor = await requireDashboardActor(event);
    if (!canApproveWorkflowPlans(actor.role)) {
      throw createError({ statusCode: 403, statusMessage: "Forbidden" });
    }
    const id = getRouterParam(event, "id");
    if (!id) throw createError({ statusCode: 404, statusMessage: "Unknown approval" });

    const outcome = await rejectApproval(id, { userId: actor.userId });
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
