import { defineEventHandler } from "h3";
import { dashboardActorLabel } from "../../../services/auth/dashboard-directory.js";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../services/auth/request-context.js";
import {
  canDispatchWorkflowRuns,
  canEditPrePrChecks,
  canEditWorkflowDefinitions,
  canInvite,
} from "../../../services/auth/roles.js";

export default defineEventHandler(async (event) => {
  try {
    const actor = await requireDashboardActor(event);
    return {
      organizationName: actor.organizationName,
      actorLabel: await dashboardActorLabel(actor.userId),
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
