import { Resend } from "resend";
import { env } from "../env.js";
import { createAuth, type AuthOptions } from "./auth.js";
import { getDb } from "./db/client.js";
import { sendEmail } from "./lib/email/send-email.js";
import { resetPasswordEmailTemplate } from "./lib/email/templates.js";
import { buildTrustedOrigins } from "./lib/auth/trusted-origins.js";

/** The worker's Better Auth instance, wired from validated env. */
export const auth = createAuth(getDb(), {
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: buildTrustedOrigins(env.DASHBOARD_ORIGIN, env.DASHBOARD_TRUSTED_ORIGINS),
  passwordReset: createPasswordResetOptions(),
});

function createPasswordResetOptions(): AuthOptions["passwordReset"] {
  const apiKey = env.RESEND_API_KEY;
  const from = env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) {
    console.warn(
      "[dashboard-auth] password reset email delivery disabled: RESEND_API_KEY and RESEND_FROM_EMAIL are not set.",
    );
    return undefined;
  }

  const client = new Resend(apiKey);
  return {
    dashboardOrigin: env.DASHBOARD_ORIGIN,
    sendEmail: async ({ user, resetUrl }) => {
      const email = resetPasswordEmailTemplate({ resetUrl });
      await sendEmail(client, {
        from,
        to: user.email,
        subject: email.subject,
        html: email.html,
        text: email.text,
      });
    },
  };
}
