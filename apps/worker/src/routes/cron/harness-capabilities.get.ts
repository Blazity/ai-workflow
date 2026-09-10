import {
  createError,
  defineEventHandler,
  getHeader,
  setResponseHeader,
} from "h3";
import { logger } from "../../infra/logger.js";
import { prewarmHarnessCapabilities } from "../../services/harness/index.js";
import { cronRequestIsAuthorized } from "../../services/triggers/index.js";

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
