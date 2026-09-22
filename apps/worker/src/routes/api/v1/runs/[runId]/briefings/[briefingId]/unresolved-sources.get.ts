import { defineEventHandler, getQuery } from "h3";

import {
  connectedBriefingReads,
  readBriefingUnresolvedSources,
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
 * The sources the compiler could not resolve for this send.
 *
 * This is the answer to "why is the AGENTS.md of that repository not in the
 * prompt": it was referenced and not found, and that is a different fact from
 * a section that was cut or a briefing that was never recorded.
 */
export default defineEventHandler(async (event) => {
  setBriefingNoStore(event);
  try {
    const actor = await requireDashboardActor(event);
    return await readBriefingUnresolvedSources(connectedBriefingReads, {
      runId: parseRunId(event),
      organizationId: actor.organizationId,
      briefingId: parseBriefingId(event),
      ...parseListQuery(getQuery(event)),
    });
  } catch (error) {
    toBriefingHttpError(error);
  }
});
