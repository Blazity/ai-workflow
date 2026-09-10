import { createError, defineEventHandler, readBody } from "h3";
import { dashboardSsoHandoffConsumeRequestSchema, parseRequestBody } from "@shared/contracts";

import { auth } from "../../../../auth-instance.js";
import {
  consumeDashboardSsoHandoff,
  toHttpError,
} from "../../../../services/auth/index.js";

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
