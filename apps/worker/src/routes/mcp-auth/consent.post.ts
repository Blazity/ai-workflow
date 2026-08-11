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
import {
  allowedScopes,
  clearOAuthFlowCookie,
  isSameOriginPost,
  readOAuthFlowCookie,
} from "../../mcp/auth-pages.js";

export default defineEventHandler(async (event) => {
  const request = toWebRequest(event);
  if (!isSameOriginPost(request, env.BETTER_AUTH_URL)) {
    throw createError({ statusCode: 403, statusMessage: "Invalid request origin" });
  }
  const oauthQuery = readOAuthFlowCookie(
    getHeader(event, "cookie") ?? null,
    env.BETTER_AUTH_SECRET,
  );
  if (!oauthQuery) {
    throw createError({ statusCode: 400, statusMessage: "OAuth request expired" });
  }
  const form = await readFormData(event);
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
  } catch {
    throw createError({ statusCode: 400, statusMessage: "OAuth request expired" });
  }
  setResponseHeader(event, "set-cookie", clearOAuthFlowCookie());
  return sendRedirect(event, result.url, 302);
});
