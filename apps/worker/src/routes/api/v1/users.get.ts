import { createError, defineEventHandler } from "h3";
import { env } from "../../../../env.js";
import { getDb } from "../../../db/client.js";
import { requireDashboardActor, toHttpError } from "../../../lib/auth/request-context.js";
import { canInvite } from "../../../lib/auth/roles.js";
import { listDashboardUsers } from "../../../lib/auth/users-read.js";

export default defineEventHandler(async (event) => {
  try {
    const actor = await requireDashboardActor(event);
    if (!canInvite(actor.role)) {
      throw createError({ statusCode: 403, statusMessage: "Forbidden" });
    }

    const members = await listDashboardUsers(getDb(), {
      organizationSlug: env.DASHBOARD_ORG_SLUG,
      actorRole: actor.role,
    });
    return { members };
  } catch (error) {
    toHttpError(error);
  }
});
