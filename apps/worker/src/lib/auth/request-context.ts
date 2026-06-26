import { createError, toWebRequest, type H3Event } from "h3";
import { env } from "../../../env.js";
import { auth } from "../../auth-instance.js";
import { getDb } from "../../db/client.js";
import { getDashboardActor, DashboardAuthError } from "./users-read.js";

export async function requireDashboardActor(event: H3Event) {
  const session = await auth.api.getSession({ headers: toWebRequest(event).headers });
  if (!session) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
  }

  const actor = await getDashboardActor(getDb(), {
    organizationSlug: env.DASHBOARD_ORG_SLUG,
    userId: session.user.id,
  });
  if (!actor) {
    throw createError({ statusCode: 403, statusMessage: "Forbidden" });
  }

  return actor;
}

export function toHttpError(error: unknown): never {
  if (error instanceof DashboardAuthError) {
    throw createError({
      statusCode: error.statusCode,
      statusMessage: error.message,
    });
  }
  throw error;
}
