import { createError, defineEventHandler, getHeader } from "h3";
import {
  cronRequestIsAuthorized,
} from "../../services/triggers/polling/cron-authorization.js";
import { getRequestSettingsSnapshot } from "../../services/settings/index.js";
import { getRequestRepositoryCatalogSnapshot } from "../../services/repository-catalog/index.js";
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
  // One load of each per tick: a pass that re-read a store per phase could
  // dispatch under one ceiling and reconcile under another, or refuse a
  // repository one phase had accepted. The catalog goes in as a thunk because
  // only the dispatch phases need it and the read is memoised on the event, so
  // a tick that does no dispatching never touches the table and a catalog that
  // cannot be read costs those phases alone rather than the housekeeping.
  return await runPollPass(
    await getRequestSettingsSnapshot(event),
    () => getRequestRepositoryCatalogSnapshot(event),
  );
});
