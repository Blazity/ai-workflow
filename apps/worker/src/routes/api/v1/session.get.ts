import { defineEventHandler } from "h3";
import {
  canDispatchWorkflowRuns,
  canEditPrePrChecks,
  canEditWorkflowDefinitions,
  canInvite,
  dashboardActorLabel,
  requireDashboardActor,
  toHttpError,
} from "../../../services/auth/index.js";

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
