import { defineEventHandler, getQuery } from "h3";

import {
  connectedBriefingReads,
  readBriefingRepositoryContext,
} from "../../../../../../../services/agent-visibility/index.js";
import { requireDashboardActor } from "../../../../../../../services/auth/request-context.js";
import {
  parseBriefingId,
  parseListQuery,
  parseRunId,
  setBriefingNoStore,
  toBriefingHttpError,
} from "../../../briefing-route.js";

/**
 * The repositories this send described, as it described them.
 *
 * Nothing here is re-read from the catalog: a repository renamed, disabled or
 * given a new description since still reads as what the agent was shown, which
 * is the only version of it that explains what the agent then did.
 */
export default defineEventHandler(async (event) => {
  setBriefingNoStore(event);
  try {
    const actor = await requireDashboardActor(event);
    return await readBriefingRepositoryContext(connectedBriefingReads, {
      runId: parseRunId(event),
      organizationId: actor.organizationId,
      briefingId: parseBriefingId(event),
      ...parseListQuery(getQuery(event)),
    });
  } catch (error) {
    toBriefingHttpError(error);
  }
});
