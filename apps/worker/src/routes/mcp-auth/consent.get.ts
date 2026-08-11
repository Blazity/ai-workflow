import { randomUUID } from "node:crypto";
import { createError, defineEventHandler, setResponseHeader, toWebRequest } from "h3";

import { env } from "../../../env.js";
import { auth } from "../../auth-instance.js";
import {
  allowedScopes,
  createOAuthFlowCookie,
  renderMcpConsentPage,
} from "../../mcp/auth-pages.js";

export default defineEventHandler(async (event) => {
  const request = toWebRequest(event);
  const oauthQuery = new URL(request.url).search.slice(1);
  const query = new URLSearchParams(oauthQuery);
  const clientId = query.get("client_id");
  const redirectUri = query.get("redirect_uri");
  const requestedScopes = (query.get("scope") ?? "").split(/\s+/).filter(Boolean);
  if (!clientId || !redirectUri || !oauthQuery) {
    throw createError({ statusCode: 400, statusMessage: "Invalid OAuth request" });
  }

  let client: Awaited<ReturnType<typeof auth.api.getOAuthClientPublicPrelogin>>;
  try {
    client = await auth.api.getOAuthClientPublicPrelogin({
      body: { client_id: clientId, oauth_query: oauthQuery },
      headers: request.headers,
    });
  } catch {
    throw createError({ statusCode: 400, statusMessage: "OAuth request expired" });
  }
  const allowed = allowedScopes(requestedScopes);
  if (
    !client.redirect_uris.includes(redirectUri) ||
    allowed.length !== new Set(requestedScopes).size
  ) {
    throw createError({ statusCode: 400, statusMessage: "Invalid OAuth request" });
  }
  const flowId = randomUUID();

  setResponseHeader(
    event,
    "set-cookie",
    createOAuthFlowCookie(oauthQuery, env.BETTER_AUTH_SECRET, new Date(), flowId),
  );
  setResponseHeader(event, "content-type", "text/html; charset=utf-8");
  return renderMcpConsentPage({
    clientName: client.client_name ?? client.client_id,
    redirectUri,
    requestedScopes: allowed,
    flowId,
  });
});
