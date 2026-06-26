import { Resend } from "resend";
import { createError, defineEventHandler, readBody } from "h3";
import { env } from "../../../../env.js";
import { getDb } from "../../../db/client.js";
import { createDashboardInvite, type SendInviteEmail } from "../../../lib/auth/invites.js";
import { requireDashboardActor, toHttpError } from "../../../lib/auth/request-context.js";
import { DashboardAuthError } from "../../../lib/auth/users-read.js";
import { sendEmail } from "../../../lib/email/send-email.js";

export default defineEventHandler(async (event) => {
  const actor = await requireDashboardActor(event);
  const body = await readBody<{ email?: string; role?: string }>(event);
  if (!body.email) {
    throw createError({ statusCode: 400, statusMessage: "Missing email" });
  }
  if (body.role && body.role !== "member") {
    throw createError({ statusCode: 400, statusMessage: "Invites can only create members" });
  }

  try {
    return await createDashboardInvite(getDb(), {
      organizationSlug: env.DASHBOARD_ORG_SLUG,
      organizationName: env.DASHBOARD_ORG_NAME,
      dashboardOrigin: env.DASHBOARD_ORIGIN,
      actor,
      email: body.email,
      sendInviteEmail: createResendInviteSender(),
    });
  } catch (error) {
    toHttpError(error);
  }
});

function createResendInviteSender(): SendInviteEmail {
  const apiKey = env.RESEND_API_KEY;
  const from = env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) {
    throw createError({ statusCode: 503, statusMessage: "Email is not configured" });
  }

  const client = new Resend(apiKey);
  return async ({ to, subject, html, text }) => {
    try {
      return await sendEmail(client, {
        from,
        to,
        subject,
        html,
        text,
      });
    } catch (error) {
      throw new DashboardAuthError(
        502,
        error instanceof Error ? error.message : "Email provider failed",
      );
    }
  };
}
