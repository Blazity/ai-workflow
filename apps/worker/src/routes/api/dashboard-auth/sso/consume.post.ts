import { createError, defineEventHandler, readBody } from "h3";
import {
  dashboardSsoHandoffConsumeRequestSchema,
  parseRequestBody,
} from "@shared/contracts";

import { auth } from "../../../../auth-instance.js";
import { toHttpError } from "../../../../services/auth/request-context.js";
import { consumeDashboardSsoHandoff } from "../../../../services/auth/sso-handoff.js";

export default defineEventHandler(async (event) => {
  const parsed = parseRequestBody(
    dashboardSsoHandoffConsumeRequestSchema,
    await readBody(event),
  );
  if (!parsed.ok) {
    throw createError({ statusCode: 400, statusMessage: parsed.message });
  }

  try {
    return await consumeDashboardSsoHandoff(auth, parsed.value.token);
  } catch (error) {
    toHttpError(error);
  }
});
