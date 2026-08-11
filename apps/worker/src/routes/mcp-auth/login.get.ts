import { defineEventHandler, setResponseHeader, toWebRequest } from "h3";

import { env } from "../../../env.js";
import { createOAuthFlowCookie, renderMcpLoginPage } from "../../mcp/auth-pages.js";

export default defineEventHandler((event) => {
  const request = toWebRequest(event);
  const oauthQuery = new URL(request.url).search.slice(1);
  if (oauthQuery) {
    setResponseHeader(
      event,
      "set-cookie",
      createOAuthFlowCookie(oauthQuery, env.BETTER_AUTH_SECRET),
    );
  }
  setResponseHeader(event, "content-type", "text/html; charset=utf-8");
  return renderMcpLoginPage({ error: null });
});
