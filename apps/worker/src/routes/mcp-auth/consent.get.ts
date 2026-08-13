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
  // Scopes only. The redirect_uri is deliberately NOT compared against
  // client.redirect_uris: /oauth2/public-client-prelogin answers a caller who is
  // not signed in yet, so it withholds the registered redirect list and returns
  // redirect_uris: [] in production. That comparison therefore refused every
  // single authorization request, and no MCP client could obtain a token at all
  // (AIW-270).
  //
  // What replaces it is not weaker. /oauth2/authorize answers 400 for a
  // redirect_uri the client did not register, before it ever redirects here, and
  // the query it forwards is HMAC-signed over its ba_param list, which includes
  // both client_id and redirect_uri. Editing either one breaks the signature,
  // the prelogin call above throws, and the request dies as "OAuth request
  // expired". So the redirect host rendered below is one the authorization
  // server already accepted for this exact client.
  if (allowed.length !== new Set(requestedScopes).size) {
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
