import { defineEventHandler, getQuery } from "h3";

import {
  connectedBriefingReads,
  readBriefingSectionSpans,
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

/**
 * Where text was removed from one section's stored copy, in stored-text bytes.
 *
 * The section header says whether every marker in the text is listed here: past
 * that ceiling a `[REDACTED]` in the text may be ours or a person's, and the
 * header is the only thing that can tell a reader so.
 */
export default defineEventHandler(async (event) => {
  setBriefingNoStore(event);
  try {
    const actor = await requireDashboardActor(event);
    return await readBriefingSectionSpans(connectedBriefingReads, {
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
