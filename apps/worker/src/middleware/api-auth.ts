import { defineEventHandler, getHeaders, type H3Event } from "h3";

import { auth } from "../auth-instance.js";
import { assertSession } from "../auth.js";

/**
 * Gate the read-only `/api/v1/*` observability API behind a valid Better Auth
 * session. The dashboard replays its httpOnly session cookie as
 * `Authorization: Bearer <token>` on every server-side worker call; a request
 * without a valid session is rejected with 401.
 *
 * Only `/api/v1/*` is gated — `/api/auth/*` (the auth handler), webhooks
 * (`/webhooks/*`, HMAC-signed) and the cron entrypoint (`/cron/*`) keep their
 * own handling.
 */
export default defineEventHandler(async (event) => {
  if (!event.path.startsWith("/api/v1/")) return;
  await assertSession(auth, headersFromEvent(event));
});

function headersFromEvent(event: H3Event): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(getHeaders(event))) {
    if (value !== undefined) headers.set(name, value);
  }
  return headers;
}
