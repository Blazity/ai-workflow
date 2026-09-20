import { defineEventHandler, getQuery } from "h3";

import {
  connectedBriefingReads,
  readBriefingAttempts,
  type BriefingAttemptsPage,
} from "../../../../../services/agent-visibility/index.js";
import { requireDashboardActor } from "../../../../../services/auth/request-context.js";
import {
  FILTER_ID_MAX_LENGTH,
  parseListQuery,
  parseRunId,
  setBriefingNoStore,
  textParam,
  toBriefingHttpError,
  wholeNumber,
} from "../briefing-route.js";

const ATTEMPT_MAX = 2_147_483_647;

/**
 * Every Block Attempt of this run that sent a prompt or could have, with the
 * briefings it produced and, where one is missing, why.
 *
 * Addressed by run rather than through the replay attempt route, which answers
 * nothing once a replay expires while the briefings are still there.
 */
export default defineEventHandler(
  async (event): Promise<BriefingAttemptsPage | undefined> => {
    setBriefingNoStore(event);
    try {
      const actor = await requireDashboardActor(event);
      const runId = parseRunId(event);
      const query = getQuery(event);
      const nodeId = textParam(query.nodeId, "nodeId", FILTER_ID_MAX_LENGTH);
      const attempt = wholeNumber(query.attempt, "attempt", { min: 1, max: ATTEMPT_MAX });
      const activationScopeId = textParam(
        query.activationScopeId,
        "activationScopeId",
        FILTER_ID_MAX_LENGTH,
      );
      return await readBriefingAttempts(connectedBriefingReads, {
        runId,
        organizationId: actor.organizationId,
        ...(nodeId === undefined ? {} : { nodeId }),
        ...(attempt === undefined ? {} : { attempt }),
        ...(activationScopeId === undefined ? {} : { activationScopeId }),
        ...parseListQuery(query),
      });
    } catch (error) {
      toBriefingHttpError(error);
    }
  },
);
