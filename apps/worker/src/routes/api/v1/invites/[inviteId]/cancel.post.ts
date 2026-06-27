import { createError, defineEventHandler, getRouterParam } from "h3";
import { env } from "../../../../../../env.js";
import { getDb } from "../../../../../db/client.js";
import { cancelDashboardInvite } from "../../../../../lib/auth/invites.js";
import { requireDashboardActor, toHttpError } from "../../../../../lib/auth/request-context.js";

export default defineEventHandler(async (event) => {
  const actor = await requireDashboardActor(event);
  const inviteId = getRouterParam(event, "inviteId");
  if (!inviteId) {
    throw createError({ statusCode: 400, statusMessage: "Missing invite id" });
  }

  try {
    return await cancelDashboardInvite(getDb(), {
      organizationSlug: env.DASHBOARD_ORG_SLUG,
      actor,
      inviteId,
    });
  } catch (error) {
    toHttpError(error);
  }
});
