import { createError, defineEventHandler, readBody } from "h3";
import {
  dashboardInviteAcceptRequestSchema,
  parseRequestBody,
} from "@shared/contracts";

import { auth } from "../../../../auth-instance.js";
import {
  acceptDashboardInviteWithPassword,
} from "../../../../services/auth/invite-requests.js";
import { getRequestSettingsSnapshot } from "../../../../services/settings/index.js";
import { toHttpError } from "../../../../services/auth/request-context.js";

export default defineEventHandler(async (event) => {
  const parsed = parseRequestBody(
    dashboardInviteAcceptRequestSchema,
    // A body that never arrived, or one that is not JSON at all, is the same
    // refusal as a body of the wrong shape, which is what the handler answered
    // when its own parse threw.
    (await readBody(event).catch(() => null)),
  );
  if (!parsed.ok) {
    throw createError({ statusCode: 400, statusMessage: parsed.message });
  }
  const body = parsed.value;

  try {
    return await acceptDashboardInviteWithPassword(auth, {
      inviteId: body.inviteId!,
      name: body.name,
      password: body.password!,
      settings: await getRequestSettingsSnapshot(event),
    });
  } catch (error) {
    toHttpError(error);
  }
});
