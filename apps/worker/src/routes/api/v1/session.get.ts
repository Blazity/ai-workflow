import { defineEventHandler } from "h3";
import { requireDashboardActor, toHttpError } from "../../../lib/auth/request-context.js";
import { canInvite } from "../../../lib/auth/roles.js";

export default defineEventHandler(async (event) => {
  try {
    const actor = await requireDashboardActor(event);
    return {
      role: actor.role,
      canManageUsers: canInvite(actor.role),
    };
  } catch (error) {
    toHttpError(error);
  }
});
