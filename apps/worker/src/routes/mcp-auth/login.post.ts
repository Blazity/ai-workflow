import {
  appendResponseHeader,
  createError,
  defineEventHandler,
  getHeader,
  readFormData,
  sendRedirect,
  splitCookiesString,
  toWebRequest,
} from "h3";

import { env } from "../../../env.js";
import { auth } from "../../auth-instance.js";
import { isSameOriginPost, readOAuthFlowCookie } from "../../mcp/auth-pages.js";

export default defineEventHandler(async (event) => {
  const incoming = toWebRequest(event);
  if (!isSameOriginPost(incoming, env.BETTER_AUTH_URL)) {
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
  const email = form.get("email");
  const password = form.get("password");
  if (typeof email !== "string" || typeof password !== "string") {
    throw createError({ statusCode: 400, statusMessage: "Email and password are required" });
  }

  const response = await auth.handler(
    new Request(`${env.BETTER_AUTH_URL.replace(/\/$/, "")}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        accept: "text/html",
        "content-type": "application/json",
        cookie: getHeader(event, "cookie") ?? "",
      },
      body: JSON.stringify({ email, password, oauth_query: oauthQuery }),
    }),
  );
  forwardCookies(event, response.headers);
  const location = response.headers.get("location");
  if (location) return sendRedirect(event, location, response.status || 302);
  const body = (await response.json().catch(() => ({}))) as { url?: unknown; message?: unknown };
  if (response.ok && typeof body.url === "string") return sendRedirect(event, body.url, 302);
  throw createError({
    statusCode: response.status || 401,
    statusMessage: typeof body.message === "string" ? body.message : "Sign in failed",
  });
});

function forwardCookies(event: Parameters<typeof appendResponseHeader>[0], headers: Headers) {
  const cookies = splitCookiesString(headers.get("set-cookie") ?? "");
  for (const cookie of cookies) appendResponseHeader(event, "set-cookie", cookie);
}
