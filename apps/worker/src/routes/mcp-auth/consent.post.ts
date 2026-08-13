import {
  createError,
  defineEventHandler,
  getHeader,
  readFormData,
  sendRedirect,
  setResponseHeader,
  toWebRequest,
} from "h3";
import { isAPIError } from "better-auth/api";

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

const AUTHORIZATION_FAILURE_CODES = new Set([
  "access_denied",
  "invalid_client",
  "invalid_grant",
  "invalid_redirect_uri",
  "invalid_request",
  "invalid_scope",
  "invalid_signature",
  "invalid_token",
  "invalid_user",
  "not_found",
  "server_error",
  "temporarily_unavailable",
  "unauthorized_client",
  "unsupported_grant_type",
  "unsupported_response_type",
]);

function normalizedAuthorizationFailureCode(value: unknown): string {
  const body = isAPIError(value) ? value.body : value;
  if (!body || typeof body !== "object" || Array.isArray(body)) return "unknown";
  const code = "error" in body && typeof body.error === "string" ? body.error : null;
  return code && AUTHORIZATION_FAILURE_CODES.has(code) ? code : "unknown";
}

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

  let response: Response;
  try {
    response = await auth.handler(
      new Request(`${env.BETTER_AUTH_URL.replace(/\/$/, "")}/api/auth/oauth2/consent`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          cookie: getHeader(event, "cookie") ?? "",
          origin: new URL(env.BETTER_AUTH_URL).origin,
        },
        body: JSON.stringify({ accept, scope: scopes.join(" "), oauth_query: oauthQuery }),
      }),
    );
  } catch (error) {
    // Better Auth puts OAuth failures in APIError.body.error and may leave
    // Error.message empty. Only emit the small known code set; never log a raw
    // provider error, which could contain request data or implementation details.
    logger.warn(
      { code: normalizedAuthorizationFailureCode(error) },
      "mcp_consent_post_rejected_by_authorization_server",
    );
    throw createError({
      statusCode: 400,
      statusMessage: "Authorization server rejected the consent",
    });
  }
  const location = response.headers.get("location");
  const result = (await response.json().catch(() => ({}))) as {
    error?: unknown;
    url?: unknown;
  };
  if ((!response.ok && !location) || (typeof result.url !== "string" && !location)) {
    logger.warn(
      { code: normalizedAuthorizationFailureCode(result) },
      "mcp_consent_post_rejected_by_authorization_server",
    );
    throw createError({
      statusCode: 400,
      statusMessage: "Authorization server rejected the consent",
    });
  }
  setResponseHeader(event, "set-cookie", clearOAuthFlowCookie());
  return sendRedirect(event, location ?? String(result.url), 302);
});
