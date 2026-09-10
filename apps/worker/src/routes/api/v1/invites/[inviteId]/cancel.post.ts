import { createError, defineEventHandler, getRouterParam } from "h3";
import { env } from "../../../../../config/env.js";
import { getDb } from "../../../../../db/client.js";
import { cancelDashboardInvite } from "../../../../../lib/auth/invites.js";
import { requireDashboardActor, toHttpError } from "../../../../../lib/auth/request-context.js";

export default defineEventHandler(async (event) => {
  try {
    const actor = await requireDashboardActor(event);
    const inviteId = getRouterParam(event, "inviteId");
    if (!inviteId) {
      throw createError({ statusCode: 400, statusMessage: "Missing invite id" });
    }

    return await cancelDashboardInvite(getDb(), {
      organizationSlug: env.DASHBOARD_ORG_SLUG,
      actor,
      inviteId,
    });
  } catch (error) {
    toHttpError(error);
  }
});
