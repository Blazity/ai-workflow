import { defineEventHandler } from "h3";
import { env } from "../../../../env.js";
import { getDb } from "../../../db/client.js";
import { listDashboardInvites } from "../../../lib/auth/invites.js";
import { requireDashboardActor, toHttpError } from "../../../lib/auth/request-context.js";

export default defineEventHandler(async (event) => {
  try {
    const actor = await requireDashboardActor(event);
    const invites = await listDashboardInvites(getDb(), {
      organizationSlug: env.DASHBOARD_ORG_SLUG,
      actor,
    });
    return { invites };
  } catch (error) {
    toHttpError(error);
  }
});
