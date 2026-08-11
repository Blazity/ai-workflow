import {
  appendResponseHeader,
  createError,
  defineEventHandler,
  getHeader,
  getQuery,
  sendRedirect,
  splitCookiesString,
  type H3Event,
} from "h3";

import { env } from "../../../../../env.js";
import { DASHBOARD_SSO_PROVIDER_ID } from "../../../../auth.js";
import { auth } from "../../../../auth-instance.js";
import { readOAuthFlowCookie, safeOAuthReturnPath } from "../../../../mcp/auth-pages.js";

export default defineEventHandler(async (event) => {
  const workerOrigin = env.BETTER_AUTH_URL.replace(/\/$/, "");
  const dashboardOrigin = env.DASHBOARD_ORIGIN.replace(/\/$/, "");
  const inviteId = inviteIdFromQuery(getQuery(event).inviteId);
  const query = getQuery(event);
  const oauthQuery =
    query.oauth === "1"
      ? readOAuthFlowCookie(getHeader(event, "cookie") ?? null, env.BETTER_AUTH_SECRET)
      : null;
  const returnTo =
    safeOAuthReturnPath(query.returnTo) ??
    (oauthQuery ? safeOAuthReturnPath(`/api/auth/oauth2/authorize?${oauthQuery}`) : null);
  const callbackUrl = new URL("/api/dashboard-auth/sso/complete", workerOrigin);
  if (inviteId) callbackUrl.searchParams.set("inviteId", inviteId);
  if (returnTo) callbackUrl.searchParams.set("returnTo", returnTo);

  const res = await auth.handler(
    new Request(`${workerOrigin}/api/auth/sign-in/sso`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providerId: DASHBOARD_SSO_PROVIDER_ID,
        providerType: "oidc",
        callbackURL: callbackUrl.href,
        errorCallbackURL: returnTo
          ? `${workerOrigin}/mcp-auth/login`
          : `${dashboardOrigin}/login`,
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
  if (typeof body.url !== "string" || !body.url) {
    throw createError({
      statusCode: 502,
      statusMessage: body.message ?? "SSO is not configured",
    });
  }

  forwardSetCookieHeaders(event, res.headers);
  return sendRedirect(event, body.url, 302);
});

function inviteIdFromQuery(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function forwardSetCookieHeaders(event: H3Event, headers: Headers) {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] })
    .getSetCookie;
  const cookies =
    typeof getSetCookie === "function"
      ? getSetCookie.call(headers)
      : splitCookiesString(headers.get("set-cookie") ?? "");

  for (const cookie of cookies) {
    appendResponseHeader(event, "set-cookie", cookie);
  }
}
