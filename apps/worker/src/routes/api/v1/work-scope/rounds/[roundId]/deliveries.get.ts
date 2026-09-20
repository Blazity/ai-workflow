import { createError, defineEventHandler, getQuery, getRouterParam } from "h3";
import { workScopeSubjectKeySchema } from "@shared/contracts";

import {
  assembleSubjectRounds,
  connectedRoundReads,
  roundDeliveriesPage,
  checkedRoundId,
} from "../../../../../../services/agent-visibility/index.js";
import { requireDashboardActor } from "../../../../../../services/auth/request-context.js";
import {
  parseListQuery,
  setBriefingNoStore,
  toBriefingHttpError,
} from "../../../runs/briefing-route.js";

/**
 * Every distinct delivery of one round's answer.
 *
 * Consecutive identical arrivals are one delivery with a count, because the
 * Jira path re-composes the answer from the ticket's comments on every poll
 * tick and a row per tick would bury the round under a weekend of retries. The
 * count and the first and last time are how that is told.
 */
export default defineEventHandler(async (event) => {
  // A round's question quotes the ticket body, exactly as a briefing does.
  setBriefingNoStore(event);
  try {
    const actor = await requireDashboardActor(event);
    const query = getQuery(event);
    const subject = workScopeSubjectKeySchema.safeParse(query.subjectKey);
    if (!subject.success) {
      throw createError({ statusCode: 400, statusMessage: "subjectKey is required" });
    }
    const assembled = await assembleSubjectRounds(connectedRoundReads, {
      subjectKey: subject.data,
      organizationId: actor.organizationId,
    });
    return roundDeliveriesPage(
      assembled,
      checkedRoundId(getRouterParam(event, "roundId")),
      parseListQuery(query),
    );
  } catch (error) {
    toBriefingHttpError(error);
  }
});
