import { defineEventHandler } from "h3";
import { getDb } from "../../../db/client.js";
import { requireDashboardActor, toHttpError } from "../../../lib/auth/request-context.js";
import {
  canDispatchWorkflowRuns,
  canEditPrePrChecks,
  canEditWorkflowDefinitions,
  canInvite,
} from "../../../lib/auth/roles.js";
import { dashboardUserLabel } from "../../../pre-pr-checks/store.js";

export default defineEventHandler(async (event) => {
  try {
    const actor = await requireDashboardActor(event);
    return {
      organizationName: actor.organizationName,
      actorLabel: await dashboardUserLabel(getDb(), actor.userId),
      role: actor.role,
      canManageUsers: canInvite(actor.role),
      canEditChecks: canEditPrePrChecks(actor.role),
      canEditWorkflows: canEditWorkflowDefinitions(actor.role),
      canDispatchWorkflows: canDispatchWorkflowRuns(actor.role),
    };
  } catch (error) {
    toHttpError(error);
  }
});
