import { createError, defineEventHandler, readBody } from "h3";

import { env } from "../../../../../env.js";
import { auth } from "../../../../auth-instance.js";
import { getDb } from "../../../../db/client.js";
import { acceptDashboardInvite } from "../../../../lib/auth/invite-acceptance.js";
import { toHttpError } from "../../../../lib/auth/request-context.js";

export default defineEventHandler(async (event) => {
  const body = await readBody<{
    inviteId?: string;
    name?: string;
    password?: string;
  }>(event);

  if (!body.inviteId) {
    throw createError({ statusCode: 400, statusMessage: "Missing invite id" });
  }
  if (!body.password) {
    throw createError({ statusCode: 400, statusMessage: "Missing password" });
  }

  try {
    return await acceptDashboardInvite(getDb(), auth, {
      organizationSlug: env.DASHBOARD_ORG_SLUG,
      inviteId: body.inviteId,
      name: body.name,
      password: body.password,
    });
  } catch (error) {
    toHttpError(error);
  }
});
