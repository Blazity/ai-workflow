import { createError, defineEventHandler, getQuery, getRouterParam } from "h3";
import { workScopeSubjectKeySchema } from "@shared/contracts";

import {
  assembleSubjectRounds,
  connectedRoundReads,
  roundEffectsPage,
  checkedRoundId,
} from "../../../../../../services/agent-visibility/index.js";
import { requireDashboardActor } from "../../../../../../services/auth/request-context.js";
import {
  parseListQuery,
  setBriefingNoStore,
  toBriefingHttpError,
} from "../../../runs/briefing-route.js";

/**
 * What one round's answer did: the Decision Trail events of its
 * clarifications, in trail order.
 *
 * The question itself is not here; it is the round's own header. What is here
 * is everything that followed from the answer, which is the half a person
 * checks when a run did something they did not expect.
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
    return roundEffectsPage(
      assembled,
      checkedRoundId(getRouterParam(event, "roundId")),
      parseListQuery(query),
    );
  } catch (error) {
    toBriefingHttpError(error);
  }
});
