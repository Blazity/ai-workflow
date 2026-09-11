import { defineEventHandler } from "h3";
import { listInvitesForActor } from "../../../services/auth/dashboard-invites.js";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../services/auth/request-context.js";

export default defineEventHandler(async (event) => {
  try {
    const actor = await requireDashboardActor(event);
    const invites = await listInvitesForActor(actor);
    return { invites };
  } catch (error) {
    toHttpError(error);
  }
});
