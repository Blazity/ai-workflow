import { createError, defineEventHandler, readBody } from "h3";

import { auth } from "../../../../auth-instance.js";
import { consumeDashboardSsoHandoff } from "../../../../lib/auth/sso-handoff.js";
import { toHttpError } from "../../../../lib/auth/request-context.js";

export default defineEventHandler(async (event) => {
  const body = await readBody<{ token?: string }>(event);
  if (typeof body?.token !== "string") {
    throw createError({ statusCode: 400, statusMessage: "Missing SSO handoff token" });
  }

  const token = body.token.trim();
  if (!token) {
    throw createError({ statusCode: 400, statusMessage: "Missing SSO handoff token" });
  }

  try {
    return await consumeDashboardSsoHandoff(auth, token);
  } catch (error) {
    toHttpError(error);
  }
});
