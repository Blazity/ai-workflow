import { createError, getHeaders, type H3Event } from "h3";
import { DashboardAuthError } from "@shared/contracts";
import {
  dashboardOrganizationSettings,
  getRequestSettingsSnapshot,
} from "../settings/index.js";
import { auth } from "./auth-instance.js";
import { getConnectedDashboardActor } from "./users-read.js";

export async function requireDashboardActor(event: H3Event) {
  const session = await auth.api.getSession({ headers: headersFromEvent(event) });
  if (!session) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
  }

  const settings = await getRequestSettingsSnapshot(event);
  const actor = await getConnectedDashboardActor({
    organizationSlug: dashboardOrganizationSettings(settings).slug,
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
