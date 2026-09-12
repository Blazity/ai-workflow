import { createError, defineEventHandler, getRouterParam } from "h3";

import { auth } from "../../../../auth-instance.js";
import {
  readDashboardInviteAcceptance,
} from "../../../../services/auth/invite-requests.js";
import { getRequestSettingsSnapshot } from "../../../../services/settings/index.js";
import { toHttpError } from "../../../../services/auth/request-context.js";

export default defineEventHandler(async (event) => {
  try {
    const inviteId = getRouterParam(event, "inviteId");
    if (!inviteId) {
      throw createError({ statusCode: 400, statusMessage: "Missing invite id" });
    }

    return await readDashboardInviteAcceptance(
      auth,
      inviteId,
      await getRequestSettingsSnapshot(event),
    );
  } catch (error) {
    toHttpError(error);
  }
});
