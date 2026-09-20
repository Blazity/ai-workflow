import { createError, defineEventHandler, getRouterParam } from "h3";

import {
  connectedBriefingReads,
  connectedNodeBriefingReadsOf,
  readNodeLastBriefing,
  type NodeLastBriefing,
} from "../../../../../../../services/agent-visibility/index.js";
import { requireDashboardActor } from "../../../../../../../services/auth/request-context.js";
import { parseDefinitionId } from "../../../../workflow-definitions.get.js";
import {
  FILTER_ID_MAX_LENGTH,
  setBriefingNoStore,
  toBriefingHttpError,
} from "../../../../runs/briefing-route.js";

/**
 * What this block last put in front of a model, over every run of this
 * definition, or the reason there is none.
 *
 * Addressed by node rather than by run because that is the question an operator
 * editing the definition has: they are looking at a block, not at a run, and
 * the run that last exercised it is what this read finds for them.
 */
export default defineEventHandler(
  async (event): Promise<NodeLastBriefing | undefined> => {
    setBriefingNoStore(event);
    try {
      const actor = await requireDashboardActor(event);
      const definitionId = parseDefinitionId(event);
      const nodeId = getRouterParam(event, "nodeId")?.trim();
      if (!nodeId || nodeId.length > FILTER_ID_MAX_LENGTH) {
        throw createError({
          statusCode: 400,
          statusMessage: `nodeId is the id of a node in this definition, at most ${FILTER_ID_MAX_LENGTH} characters`,
        });
      }
      return await readNodeLastBriefing(connectedNodeBriefingReadsOf(connectedBriefingReads), {
        definitionId,
        nodeId,
        organizationId: actor.organizationId,
      });
    } catch (error) {
      toBriefingHttpError(error);
    }
  },
);
