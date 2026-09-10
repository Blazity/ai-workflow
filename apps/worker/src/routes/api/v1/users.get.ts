import { createError, defineEventHandler } from "h3";
import {
  canInvite,
  listDashboardDirectory,
  requireDashboardActor,
  toHttpError,
} from "../../../services/auth/index.js";

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
