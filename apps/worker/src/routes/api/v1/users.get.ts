import { createError, defineEventHandler } from "h3";
import { listDashboardDirectory } from "../../../services/auth/dashboard-directory.js";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../services/auth/request-context.js";
import { canInvite } from "../../../services/auth/roles.js";

export default defineEventHandler(async (event) => {
  try {
    const actor = await requireDashboardActor(event);
    if (!canInvite(actor.role)) {
      throw createError({ statusCode: 403, statusMessage: "Forbidden" });
    }

    const users = await listDashboardDirectory(actor.role);
    return { users };
  } catch (error) {
    toHttpError(error);
  }
});
