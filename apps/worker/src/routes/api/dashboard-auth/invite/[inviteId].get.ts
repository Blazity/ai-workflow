import { createError, defineEventHandler, getRouterParam } from "h3";

import { auth } from "../../../../auth-instance.js";
import {
  readDashboardInviteAcceptance,
  toHttpError,
} from "../../../../services/auth/index.js";

export default defineEventHandler(async (event) => {
  try {
    const inviteId = getRouterParam(event, "inviteId");
    if (!inviteId) {
      throw createError({ statusCode: 400, statusMessage: "Missing invite id" });
    }

    return await readDashboardInviteAcceptance(auth, inviteId);
  } catch (error) {
    toHttpError(error);
  }
});
