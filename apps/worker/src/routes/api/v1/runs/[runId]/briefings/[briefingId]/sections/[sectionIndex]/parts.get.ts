import { defineEventHandler, getQuery } from "h3";

import {
  connectedBriefingReads,
  readBriefingSectionParts,
} from "../../../../../../../../../services/agent-visibility/index.js";
import { requireDashboardActor } from "../../../../../../../../../services/auth/request-context.js";
import {
  parseBriefingId,
  parseListQuery,
  parseRunId,
  parseSectionIndex,
  setBriefingNoStore,
  toBriefingHttpError,
} from "../../../../../briefing-route.js";

/** The named pieces of one section, in order: together they are its whole
 *  stored text, and each says where it came from and what was cut from it. */
export default defineEventHandler(async (event) => {
  setBriefingNoStore(event);
  try {
    const actor = await requireDashboardActor(event);
    return await readBriefingSectionParts(connectedBriefingReads, {
      runId: parseRunId(event),
      organizationId: actor.organizationId,
      briefingId: parseBriefingId(event),
      sectionIndex: parseSectionIndex(event),
      ...parseListQuery(getQuery(event)),
    });
  } catch (error) {
    toBriefingHttpError(error);
  }
});
