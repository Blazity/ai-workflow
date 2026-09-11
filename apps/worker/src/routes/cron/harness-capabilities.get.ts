import {
  createError,
  defineEventHandler,
  getHeader,
  setResponseHeader,
} from "h3";
import { logger } from "../../services/system/logger.js";
// Cluster modules, not barrels: one auth helper and one prewarm entry point do
// not need the polling pass, the webhook handlers or the engine graph those
// barrels re-export.
import { prewarmHarnessCapabilities } from "../../services/harness/capabilities.js";
import { cronRequestIsAuthorized } from "../../services/triggers/polling/cron-authorization.js";

/**
 * The scheduled capability prewarm.
 *
 * Same two protocol facts as the poll: the platform sends its shared secret as a
 * bearer token, and the pass reports as JSON. What a prewarm does is the harness
 * cluster's.
 */
export default defineEventHandler(async (event) => {
  if (!cronRequestIsAuthorized(getHeader(event, "authorization"))) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
  }
  setResponseHeader(event, "Cache-Control", "private, no-store");

  const result = await prewarmHarnessCapabilities();
  logger.info(
    {
      event: "harness_capability_prewarm",
      ...result,
    },
    "Harness capability prewarm completed",
  );
  return { status: "ok", ...result };
});
