import { createError, getHeaders, type H3Event } from "h3";
import { env } from "../../../env.js";
import { auth } from "../../auth-instance.js";
import { getDb } from "../../db/client.js";
import { getDashboardActor, DashboardAuthError } from "./users-read.js";

export async function requireDashboardActor(event: H3Event) {
  const session = await auth.api.getSession({ headers: headersFromEvent(event) });
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

function headersFromEvent(event: H3Event): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(getHeaders(event))) {
    if (value !== undefined) headers.set(name, value);
  }
  return headers;
}
