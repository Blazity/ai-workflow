import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import {
  dashboardUserRoleUpdateRequestSchema,
  parseRequestBody,
} from "@shared/contracts";
import {
  changeDashboardUserRole,
  requireDashboardActor,
  toHttpError,
} from "../../../../../services/auth/index.js";

export default defineEventHandler(async (event) => {
  try {
    const actor = await requireDashboardActor(event);
    const userId = getRouterParam(event, "userId");
    if (!userId) {
      throw createError({ statusCode: 400, statusMessage: "Missing user id" });
    }

    const parsed = parseRequestBody(
      dashboardUserRoleUpdateRequestSchema,
      (await readBody(event).catch(() => null)) ?? {},
    );
    if (!parsed.ok) {
      throw createError({ statusCode: 400, statusMessage: parsed.message });
    }

    return await changeDashboardUserRole({
      actorRole: actor.role,
      targetUserId: userId,
      nextRole: parsed.value.role,
    });
  } catch (error) {
    toHttpError(error);
  }
});
