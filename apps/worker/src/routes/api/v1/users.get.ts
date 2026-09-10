import { createError, defineEventHandler } from "h3";
import { env } from "../../../config/env.js";
import { getDb } from "../../../db/client.js";
import { requireDashboardActor, toHttpError } from "../../../services/auth/request-context.js";
import { canInvite } from "../../../services/auth/roles.js";
import { listDashboardUsers } from "../../../services/auth/users-read.js";

export default defineEventHandler(async (event) => {
  try {
    const actor = await requireDashboardActor(event);
    if (!canInvite(actor.role)) {
      throw createError({ statusCode: 403, statusMessage: "Forbidden" });
    }

    const users = await listDashboardUsers(getDb(), {
      organizationSlug: env.DASHBOARD_ORG_SLUG,
      actorRole: actor.role,
    });
    return { users };
  } catch (error) {
    toHttpError(error);
  }
});
