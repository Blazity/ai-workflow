import type { ManualDispatchResponse } from "@shared/contracts";
import { manualDispatchRequestSchema, parseRequestBody } from "@shared/contracts";
import {
  createError,
  defineEventHandler,
  getRouterParam,
  readBody,
  setResponseStatus,
} from "h3";
import {
  canDispatchWorkflowRuns,
  requireDashboardActor,
} from "../../../../../../../services/auth/index.js";
import { toManualDispatchHttpError } from "../../../../../../../services/manual-dispatch/index.js";
import { dispatchTriggerManually } from "../../../../../../../services/workflow-definitions/index.js";
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
      const parsed = parseRequestBody(
        manualDispatchRequestSchema,
        await readBody(event).catch(() => null),
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }
      const request = parsed.value;
      const response = await dispatchTriggerManually({
        definitionId,
        triggerNodeId,
        request,
        actorId: actor.userId,
        actorRole: actor.role,
      });
      setResponseStatus(event, response.status === "started" ? 201 : 202);
      return response;
    } catch (error) {
      toManualDispatchHttpError(error);
    }
  },
);
