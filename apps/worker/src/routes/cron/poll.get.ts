import { createError, defineEventHandler, getHeader } from "h3";
import {
  cronRequestIsAuthorized,
} from "../../services/triggers/polling/cron-authorization.js";
import { getRequestSettingsSnapshot } from "../../services/settings/index.js";
import { runPollPass } from "../../services/triggers/polling/poll-pass.js";

/**
 * The scheduled poll.
 *
 * Two protocol facts live here and nothing else: the platform sends its shared
 * secret as a bearer token, and the pass reports as JSON. What the pass does, in
 * what order, and what it tolerates failing is `services/triggers`.
 */
export default defineEventHandler(async (event) => {
  if (!cronRequestIsAuthorized(getHeader(event, "authorization"))) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
  }
  // One load at the start of the tick, handed to every phase below: a pass that
  // re-read the store per phase could dispatch under one ceiling and reconcile
  // under another.
  return await runPollPass(await getRequestSettingsSnapshot(event));
});
