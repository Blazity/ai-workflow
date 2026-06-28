import { createError, defineEventHandler } from "h3";

import { env } from "../../../../../env.js";
import { DASHBOARD_SSO_PROVIDER_ID } from "../../../../auth.js";
import { auth } from "../../../../auth-instance.js";

export default defineEventHandler(async () => {
  const workerOrigin = env.BETTER_AUTH_URL.replace(/\/$/, "");
  const dashboardOrigin = env.DASHBOARD_ORIGIN.replace(/\/$/, "");
  const res = await auth.handler(
    new Request(`${workerOrigin}/api/auth/sign-in/sso`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providerId: DASHBOARD_SSO_PROVIDER_ID,
        providerType: "oidc",
        callbackURL: `${workerOrigin}/api/dashboard-auth/sso/complete`,
        errorCallbackURL: `${dashboardOrigin}/login`,
      }),
    }),
  );

  const body = (await res.json().catch(() => ({}))) as {
    url?: string;
    message?: string;
  };
  if (!res.ok) {
    throw createError({
      statusCode: res.status || 502,
      statusMessage: body.message ?? "SSO is not configured",
    });
  }
  if (!body.url) {
    throw createError({
      statusCode: 502,
      statusMessage: body.message ?? "SSO is not configured",
    });
  }

  return { url: body.url };
});
