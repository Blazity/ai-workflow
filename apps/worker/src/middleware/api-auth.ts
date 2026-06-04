import { defineEventHandler, getHeader } from "h3";

import { env } from "../../env.js";
import { verifyApiToken } from "../lib/api-auth.js";

/**
 * Gate the read-only `/api/v1/*` observability API behind a shared bearer
 * token. The dashboard (a separate deployment) fetches these endpoints
 * server-side with `Authorization: Bearer <WORKER_API_TOKEN>`; any request
 * without a matching token is rejected with 401.
 *
 * Only `/api/v1/*` is gated — webhooks (`/webhooks/*`, HMAC-signed) and the
 * cron entrypoint (`/cron/*`) keep their own auth.
 */
export default defineEventHandler((event) => {
  if (!event.path.startsWith("/api/v1/")) return;
  verifyApiToken(getHeader(event, "authorization"), env.WORKER_API_TOKEN);
});
