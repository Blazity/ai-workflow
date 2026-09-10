import { createError, defineEventHandler, readBody } from "h3";
import {
  dashboardInviteCreateRequestSchema,
  parseRequestBody,
} from "@shared/contracts";
import {
  createInviteForActor,
  requireDashboardActor,
  toHttpError,
} from "../../../services/auth/index.js";

export default defineEventHandler(async (event) => {
  const actor = await requireDashboardActor(event);
  // Not tolerant of an unreadable body, unlike the other bodies here: a request
  // whose JSON does not parse is refused by readBody itself, as it always was.
  const parsed = parseRequestBody(
    dashboardInviteCreateRequestSchema,
    (await readBody(event)) ?? {},
  );
  if (!parsed.ok) {
    throw createError({ statusCode: 400, statusMessage: parsed.message });
  }

  try {
    return await createInviteForActor({ actor, email: parsed.value.email });
  } catch (error) {
    toHttpError(error);
  }
});
