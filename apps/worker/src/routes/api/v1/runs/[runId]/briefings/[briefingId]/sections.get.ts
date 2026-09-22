import { defineEventHandler, getQuery } from "h3";

import {
  connectedBriefingReads,
  readBriefingSections,
} from "../../../../../../../services/agent-visibility/index.js";
import { requireDashboardActor } from "../../../../../../../services/auth/request-context.js";
import {
  parseBriefingId,
  parseListQuery,
  parseRunId,
  setBriefingNoStore,
  toBriefingHttpError,
} from "../../../briefing-route.js";

/** The sections of one send: everything about each but its text, its parts and
 *  its spans, which are lists of their own. */
export default defineEventHandler(async (event) => {
  setBriefingNoStore(event);
  try {
    const actor = await requireDashboardActor(event);
    return await readBriefingSections(connectedBriefingReads, {
      runId: parseRunId(event),
      organizationId: actor.organizationId,
      briefingId: parseBriefingId(event),
      ...parseListQuery(getQuery(event)),
    });
  } catch (error) {
    toBriefingHttpError(error);
  }
});
