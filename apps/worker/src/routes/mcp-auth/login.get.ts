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

import { auth } from "../../auth-instance.js";
import {
  createOAuthFlowCookie,
  readOAuthFlowCookie,
} from "../../services/auth/oauth-flow-cookie.js";
import {
  dashboardOriginUrl,
  workerOriginUrl,
} from "../../services/auth/sso-redirects.js";
import {
  isOAuthAuthorizationQuery,
  isOpaqueHandoffToken,
  oauthConsentUrl,
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
      createOAuthFlowCookie(oauthQuery),
    );
  }

  const flowQuery =
    oauthQuery ??
    readOAuthFlowCookie(getHeader(event, "cookie") ?? null);

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
    return sendRedirect(event, oauthConsentUrl(flowQuery, workerOriginUrl()), 302);
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (session && flowQuery) {
    return sendRedirect(event, oauthConsentUrl(flowQuery, workerOriginUrl()), 302);
  }

  if (oauthQuery && !session) {
    const dashboardBridge = new URL(
      "/api/auth/sso/mcp-session",
      dashboardOriginUrl(),
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
