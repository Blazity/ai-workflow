import type { ManualDispatchResponse } from "@shared/contracts";
import {
  createError,
  defineEventHandler,
  getRouterParam,
  readBody,
  setResponseStatus,
} from "h3";
import { env } from "../../../../../../../../env.js";
import { getDb } from "../../../../../../../db/client.js";
import { createAdapters } from "../../../../../../../lib/adapters.js";
import { requireDashboardActor } from "../../../../../../../lib/auth/request-context.js";
import { canDispatchWorkflowRuns } from "../../../../../../../lib/auth/roles.js";
import {
  parseManualDispatchRequest,
  toManualDispatchHttpError,
} from "../../../../../../../manual-dispatch/http.js";
import { dispatchManualWorkflow } from "../../../../../../../manual-dispatch/service.js";
import { dashboardUserLabel } from "../../../../../../../pre-pr-checks/store.js";
import { parseDefinitionId } from "../../../../workflow-definitions.get.js";

export default defineEventHandler(
  async (event): Promise<ManualDispatchResponse | undefined> => {
    try {
      const actor = await requireDashboardActor(event);
      if (!canDispatchWorkflowRuns(actor.role)) {
        throw createError({ statusCode: 403, statusMessage: "Forbidden" });
      }
      const definitionId = parseDefinitionId(event);
      const triggerNodeId = getRouterParam(event, "nodeId")?.trim();
      if (!triggerNodeId) {
        throw createError({ statusCode: 404, statusMessage: "Unknown trigger" });
      }
      const request = parseManualDispatchRequest(
        await readBody<unknown>(event).catch(() => null),
      );
      const db = getDb();
      const response = await dispatchManualWorkflow({
        db,
        adapters: createAdapters(),
        definitionId,
        triggerNodeId,
        request,
        actor: {
          id: actor.userId,
          label: await dashboardUserLabel(db, actor.userId),
        },
        maxConcurrentAgents: env.MAX_CONCURRENT_AGENTS,
      });
      setResponseStatus(event, response.status === "started" ? 201 : 202);
      return response;
    } catch (error) {
      toManualDispatchHttpError(error);
    }
  },
);
