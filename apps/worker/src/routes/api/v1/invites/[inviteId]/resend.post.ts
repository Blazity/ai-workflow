import { createError, defineEventHandler, getRouterParam } from "h3";
import {
  resendInviteForActor,
} from "../../../../../services/auth/dashboard-invites.js";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../../services/auth/request-context.js";

export default defineEventHandler(async (event) => {
  const actor = await requireDashboardActor(event);
  const inviteId = getRouterParam(event, "inviteId");
  if (!inviteId) {
    throw createError({ statusCode: 400, statusMessage: "Missing invite id" });
  }

  try {
    return await resendInviteForActor({ actor, inviteId });
  } catch (error) {
    toHttpError(error);
  }
});
