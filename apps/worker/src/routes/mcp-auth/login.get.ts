import {
  appendResponseHeader,
  createError,
  defineEventHandler,
  getHeader,
  sendRedirect,
  setResponseHeader,
  splitCookiesString,
  toWebRequest,
} from "h3";

import { env } from "../../../env.js";
import { auth } from "../../auth-instance.js";
import {
  createOAuthFlowCookie,
  isOAuthAuthorizationQuery,
  isOpaqueHandoffToken,
  oauthConsentUrl,
  readOAuthFlowCookie,
  renderMcpLoginPage,
} from "../../mcp/auth-pages.js";

export default defineEventHandler(async (event) => {
  setResponseHeader(event, "cache-control", "no-store");
  const request = toWebRequest(event);
  const url = new URL(request.url);
  const handoffToken = url.searchParams.get("handoff");
  const fallback = url.searchParams.get("fallback") === "1";
  const oauthQuery =
    !handoffToken && !fallback && isOAuthAuthorizationQuery(url.searchParams)
      ? url.search.slice(1)
      : null;
  if (oauthQuery) {
    setResponseHeader(
      event,
      "set-cookie",
      createOAuthFlowCookie(oauthQuery, env.BETTER_AUTH_SECRET),
    );
  }

  const flowQuery =
    oauthQuery ??
    readOAuthFlowCookie(getHeader(event, "cookie") ?? null, env.BETTER_AUTH_SECRET);

  if (handoffToken) {
    if (!isOpaqueHandoffToken(handoffToken) || !flowQuery) {
      throw createError({ statusCode: 400, statusMessage: "Invalid login handoff" });
    }

    let verification: { headers: Headers };
    try {
      verification = (await auth.api.verifyOneTimeToken({
        body: { token: handoffToken },
        returnHeaders: true,
      })) as unknown as { headers: Headers };
    } catch {
      throw createError({ statusCode: 401, statusMessage: "Invalid login handoff" });
    }
    forwardCookies(event, verification.headers);
    return sendRedirect(event, oauthConsentUrl(flowQuery, env.BETTER_AUTH_URL), 302);
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (session && flowQuery) {
    return sendRedirect(event, oauthConsentUrl(flowQuery, env.BETTER_AUTH_URL), 302);
  }

  if (oauthQuery && !session) {
    const dashboardBridge = new URL(
      "/api/auth/sso/mcp-session",
      env.DASHBOARD_ORIGIN,
    );
    return sendRedirect(event, dashboardBridge.href, 302);
  }

  setResponseHeader(event, "content-type", "text/html; charset=utf-8");
  return renderMcpLoginPage({ error: null });
});

function forwardCookies(
  event: Parameters<typeof appendResponseHeader>[0],
  headers: Headers,
) {
  const cookies = splitCookiesString(headers.get("set-cookie") ?? "");
  for (const cookie of cookies) appendResponseHeader(event, "set-cookie", cookie);
}
