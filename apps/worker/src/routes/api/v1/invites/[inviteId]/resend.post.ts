import { Resend } from "resend";
import { createError, defineEventHandler, getRouterParam } from "h3";
import { env } from "../../../../../../env.js";
import { getDb } from "../../../../../db/client.js";
import { resendDashboardInvite, type SendInviteEmail } from "../../../../../lib/auth/invites.js";
import { requireDashboardActor, toHttpError } from "../../../../../lib/auth/request-context.js";
import { DashboardAuthError } from "../../../../../lib/auth/users-read.js";
import { sendEmail } from "../../../../../lib/email/send-email.js";

export default defineEventHandler(async (event) => {
  const actor = await requireDashboardActor(event);
  const inviteId = getRouterParam(event, "inviteId");
  if (!inviteId) {
    throw createError({ statusCode: 400, statusMessage: "Missing invite id" });
  }
  const sendInviteEmail = createResendInviteSender();

  try {
    return await resendDashboardInvite(getDb(), {
      organizationSlug: env.DASHBOARD_ORG_SLUG,
      organizationName: env.DASHBOARD_ORG_NAME,
      dashboardOrigin: env.DASHBOARD_ORIGIN,
      actor,
      inviteId,
      sendInviteEmail,
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
  return async ({ to, subject, html, text, deliveryId }) => {
    try {
      return await sendEmail(client, {
        from,
        to,
        subject,
        html,
        text,
        tags: [{ name: "invite_delivery_id", value: deliveryId }],
      });
    } catch (error) {
      throw new DashboardAuthError(
        502,
        error instanceof Error ? error.message : "Email provider failed",
      );
    }
  };
}
