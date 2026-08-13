import {
  createError,
  defineEventHandler,
  getHeader,
  readFormData,
  sendRedirect,
  setResponseHeader,
  toWebRequest,
} from "h3";

import { env } from "../../../env.js";
import { auth } from "../../auth-instance.js";
import { logger } from "../../lib/logger.js";
import {
  allowedScopes,
  clearOAuthFlowCookie,
  describeOAuthFlowCookie,
  isSameOriginPost,
  readOAuthFlowCookie,
} from "../../mcp/auth-pages.js";

export default defineEventHandler(async (event) => {
  // Order restored deliberately, and worth a note so nobody "fixes" it again:
  // taking the web request before reading the form does NOT consume the body
  // twice. readFormData is literally toWebRequest(event).formData()
  // (h3 index.mjs:473-474), and toWebRequest returns event.web.request when the
  // adapter already made one, or builds a fresh Request over the same stream
  // (:339-347). The first request here never reads its body, only the method and
  // the origin header, so the stream is still intact for the form read below.
  const request = toWebRequest(event);
  if (!isSameOriginPost(request, env.BETTER_AUTH_URL)) {
    throw createError({ statusCode: 403, statusMessage: "Invalid request origin" });
  }
  const form = await readFormData(event);
  const flowId = form.get("flow_id");
  if (typeof flowId !== "string" || !flowId) {
    // Distinct from the two failures below on purpose. All three used to answer
    // "OAuth request expired", so a production 400 could not be attributed from
    // the outside OR from the logs, on the only path to a token.
    logger.warn(
      { fields: [...form.keys()], contentType: getHeader(event, "content-type") ?? null },
      "mcp_consent_post_missing_field",
    );
    throw createError({ statusCode: 400, statusMessage: "Missing consent form field" });
  }
  const oauthQuery = readOAuthFlowCookie(
    getHeader(event, "cookie") ?? null,
    env.BETTER_AUTH_SECRET,
    new Date(),
    flowId,
  );
  if (!oauthQuery) {
    // Says which of the cookie's gates refused, because "unreadable" covers a
    // cookie that never arrived, one signed by a different secret, one carrying
    // another flow id, and one outside its window.
    logger.warn(
      {
        cookiePresent: (getHeader(event, "cookie") ?? "").includes("mcp_oauth="),
        reason: describeOAuthFlowCookie(
          getHeader(event, "cookie") ?? null,
          env.BETTER_AUTH_SECRET,
          new Date(),
          flowId,
        ),
      },
      "mcp_consent_post_cookie_unreadable",
    );
    throw createError({ statusCode: 400, statusMessage: "Consent flow cookie was not readable" });
  }
  const accept = form.get("accept") === "true";
  const requestedScopes =
    typeof form.get("scope") === "string"
      ? String(form.get("scope")).split(/\s+/).filter(Boolean)
      : [];
  const scopes = allowedScopes(requestedScopes);
  if (scopes.length !== new Set(requestedScopes).size) {
    throw createError({ statusCode: 400, statusMessage: "Invalid OAuth scope" });
  }

  let result: Awaited<ReturnType<typeof auth.api.oauth2Consent>>;
  try {
    result = await auth.api.oauth2Consent({
      body: { accept, scope: scopes.join(" "), oauth_query: oauthQuery },
      headers: request.headers,
    });
  } catch (error) {
    // The authorization server's own refusal, logged with its real message. This
    // is the path a broken signature or an expired ba_iat actually takes, and it
    // is the only one of the three that genuinely means "expired".
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "mcp_consent_post_rejected_by_authorization_server",
    );
    throw createError({
      statusCode: 400,
      statusMessage: "Authorization server rejected the consent",
    });
  }
  setResponseHeader(event, "set-cookie", clearOAuthFlowCookie());
  return sendRedirect(event, result.url, 302);
});
