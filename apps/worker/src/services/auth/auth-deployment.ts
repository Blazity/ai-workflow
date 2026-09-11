import { Resend } from "resend";

import { env } from "../../infra/vcs-config.js";
import { resetPasswordEmailTemplate, sendEmail } from "../email/index.js";
import type { AuthOptions } from "./auth-core.js";
import { buildTrustedOrigins } from "./trusted-origins.js";

/** Values and service callbacks needed by the app-tier auth instance. */
export function authDeployment() {
  return {
    options: {
      secret: env.BETTER_AUTH_SECRET,
      baseURL: env.BETTER_AUTH_URL,
      trustedOrigins: buildTrustedOrigins(
        env.DASHBOARD_ORIGIN,
        env.DASHBOARD_TRUSTED_ORIGINS,
      ),
      mcp: {
        organizationSlug: env.DASHBOARD_ORG_SLUG,
        allowPublicDcr: env.MCP_ALLOW_PUBLIC_DCR,
      },
      passwordReset: createPasswordResetOptions(),
    } satisfies AuthOptions,
  };
}

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
