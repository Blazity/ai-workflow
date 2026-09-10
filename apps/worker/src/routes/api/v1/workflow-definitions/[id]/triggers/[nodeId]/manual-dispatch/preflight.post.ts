import type { ManualDispatchPreflightResponse } from "@shared/contracts";
import { manualDispatchInputSchema, parseRequestBody } from "@shared/contracts";
import {
  createError,
  defineEventHandler,
  getRouterParam,
  readBody,
} from "h3";
import {
  canDispatchWorkflowRuns,
  requireDashboardActor,
} from "../../../../../../../../services/auth/index.js";
import { toManualDispatchHttpError } from "../../../../../../../../services/manual-dispatch/index.js";
import { preflightTriggerDispatch } from "../../../../../../../../services/workflow-definitions/index.js";
import { parseDefinitionId } from "../../../../../workflow-definitions.get.js";

export default defineEventHandler(
  async (event): Promise<ManualDispatchPreflightResponse | undefined> => {
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
        manualDispatchInputSchema,
        await readBody(event).catch(() => null),
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }
      const dispatchInput = parsed.value;
      return await preflightTriggerDispatch({
        definitionId,
        triggerNodeId,
        dispatchInput,
      });
    } catch (error) {
      toManualDispatchHttpError(error);
    }
  },
);
