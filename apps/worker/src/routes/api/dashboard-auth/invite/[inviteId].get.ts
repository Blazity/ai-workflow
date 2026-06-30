import { createError, defineEventHandler, getRouterParam } from "h3";

import { env } from "../../../../../env.js";
import { auth } from "../../../../auth-instance.js";
import { getDb } from "../../../../db/client.js";
import { getDashboardInviteAcceptanceState } from "../../../../lib/auth/invite-acceptance.js";
import { toHttpError } from "../../../../lib/auth/request-context.js";

export default defineEventHandler(async (event) => {
  try {
    const inviteId = getRouterParam(event, "inviteId");
    if (!inviteId) {
      throw createError({ statusCode: 400, statusMessage: "Missing invite id" });
    }

    return await getDashboardInviteAcceptanceState(getDb(), auth, {
      organizationSlug: env.DASHBOARD_ORG_SLUG,
      inviteId,
    });
  } catch (error) {
    toHttpError(error);
  }
});
