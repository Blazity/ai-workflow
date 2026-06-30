import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { env } from "../../../../../../env.js";
import { getDb } from "../../../../../db/client.js";
import { requireDashboardActor, toHttpError } from "../../../../../lib/auth/request-context.js";
import { updateDashboardUserRole } from "../../../../../lib/auth/users-read.js";

export default defineEventHandler(async (event) => {
  try {
    const actor = await requireDashboardActor(event);
    const userId = getRouterParam(event, "userId");
    if (!userId) {
      throw createError({ statusCode: 400, statusMessage: "Missing user id" });
    }

    const body = (await readBody<{ role?: string }>(event).catch(() => null)) ?? {};
    if (body.role !== "admin" && body.role !== "member") {
      throw createError({ statusCode: 400, statusMessage: "Invalid role" });
    }

    return await updateDashboardUserRole(getDb(), {
      organizationSlug: env.DASHBOARD_ORG_SLUG,
      actorRole: actor.role,
      targetUserId: userId,
      nextRole: body.role,
    });
  } catch (error) {
    toHttpError(error);
  }
});
