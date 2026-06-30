import { createError, defineEventHandler, readBody } from "h3";

import { env } from "../../../../../env.js";
import { auth } from "../../../../auth-instance.js";
import { getDb } from "../../../../db/client.js";
import { acceptDashboardInvite } from "../../../../lib/auth/invite-acceptance.js";
import { toHttpError } from "../../../../lib/auth/request-context.js";

type AcceptInviteBody = {
  inviteId?: string;
  name?: string;
  password?: string;
};

export default defineEventHandler(async (event) => {
  let body: AcceptInviteBody;
  try {
    body = parseBody(await readBody(event));
  } catch {
    throw createError({ statusCode: 400, statusMessage: "Invalid request body" });
  }

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

function parseBody(body: unknown): AcceptInviteBody {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Invalid request body");
  }

  const input = body as Record<string, unknown>;
  if (
    (input.inviteId !== undefined && typeof input.inviteId !== "string") ||
    (input.password !== undefined && typeof input.password !== "string") ||
    (input.name !== undefined && typeof input.name !== "string")
  ) {
    throw new Error("Invalid request body");
  }

  return {
    inviteId: input.inviteId,
    name: input.name,
    password: input.password,
  };
}
