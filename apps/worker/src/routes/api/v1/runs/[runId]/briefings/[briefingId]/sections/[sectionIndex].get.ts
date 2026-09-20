import { defineEventHandler, getQuery } from "h3";

import {
  AGENT_VISIBILITY_PAGE_MAX_BYTES,
  AGENT_VISIBILITY_PAGE_MIN_BYTES,
  connectedBriefingReads,
  readBriefingSectionPage,
} from "../../../../../../../../services/agent-visibility/index.js";
import { requireDashboardActor } from "../../../../../../../../services/auth/request-context.js";
import {
  parseBriefingId,
  parseRunId,
  parseSectionIndex,
  setBriefingNoStore,
  toBriefingHttpError,
  wholeNumber,
} from "../../../../briefing-route.js";

/** Sections are cut at 200,000 UTF-16 units before they are stored, so a byte
 *  offset into one cannot be larger than this. */
const SECTION_BYTES_MAX = 64 * 1024 * 1024;

/**
 * One page of one section's stored text, by byte offset.
 *
 * `offset` is a byte of the STORED text and comes from the previous page's
 * `nextOffset`; a hand-made offset inside a character is refused rather than
 * snapped, because snapping would repeat or skip bytes without saying so.
 */
export default defineEventHandler(async (event) => {
  setBriefingNoStore(event);
  try {
    const actor = await requireDashboardActor(event);
    const query = getQuery(event);
    const offset = wholeNumber(query.offset, "offset", { min: 0, max: SECTION_BYTES_MAX });
    const limit = wholeNumber(query.limit, "limit", {
      min: AGENT_VISIBILITY_PAGE_MIN_BYTES,
      max: AGENT_VISIBILITY_PAGE_MAX_BYTES,
    });
    return await readBriefingSectionPage(connectedBriefingReads, {
      runId: parseRunId(event),
      organizationId: actor.organizationId,
      briefingId: parseBriefingId(event),
      sectionIndex: parseSectionIndex(event),
      ...(offset === undefined ? {} : { offset }),
      ...(limit === undefined ? {} : { limit }),
    });
  } catch (error) {
    toBriefingHttpError(error);
  }
});
