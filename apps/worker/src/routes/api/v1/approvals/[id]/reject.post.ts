import { createError, defineEventHandler, getRouterParam } from "h3";
import type { ApprovalDecisionResponse } from "@shared/contracts";
import { getDb } from "../../../../../db/client.js";
import { requireDashboardActor } from "../../../../../lib/auth/request-context.js";
import { canApproveWorkflowPlans } from "../../../../../lib/auth/roles.js";
import { createStepAdapters } from "../../../../../lib/step-adapters.js";
import { dashboardUserLabel } from "../../../../../pre-pr-checks/store.js";
import {
  decideApproval,
  getApproval,
  serializeApproval,
} from "../../../../../approvals/store.js";
import { toApprovalHttpError } from "../../approvals.get.js";

export default defineEventHandler(async (event): Promise<ApprovalDecisionResponse | undefined> => {
  try {
    const actor = await requireDashboardActor(event);
    if (!canApproveWorkflowPlans(actor.role)) {
      throw createError({ statusCode: 403, statusMessage: "Forbidden" });
    }
    const id = getRouterParam(event, "id");
    if (!id) throw createError({ statusCode: 404, statusMessage: "Unknown approval" });

    const db = getDb();
    const row = await getApproval(db, id);
    if (!row) throw createError({ statusCode: 404, statusMessage: "Unknown approval" });
    if (row.status !== "pending") {
      throw createError({ statusCode: 409, statusMessage: "already_decided" });
    }

    const label = await dashboardUserLabel(db, actor.userId);
    const decided = await decideApproval(db, {
      id,
      decision: "rejected",
      actor: { id: actor.userId, label },
    });

    const { issueTracker } = createStepAdapters();
    await issueTracker.postComment(row.ticketKey, `Plan rejected by ${label}.`).catch(() => {});

    return { approval: serializeApproval(decided), runId: null };
  } catch (error) {
    toApprovalHttpError(error);
  }
});
