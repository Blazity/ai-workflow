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
  requireDashboardActor,
} from "../../../../../../../services/auth/request-context.js";
import { canDispatchWorkflowRuns } from "../../../../../../../services/auth/roles.js";
import {
  toManualDispatchHttpError,
} from "../../../../../../../services/manual-dispatch/http.js";
import {
  dispatchTriggerManually,
} from "../../../../../../../services/workflow-definitions/trigger-manual-dispatch.js";
import { getRequestSettingsSnapshot } from "../../../../../../../services/settings/index.js";
import { getRequestRepositoryCatalogSnapshot } from "../../../../../../../services/repository-catalog/index.js";
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
        settings: await getRequestSettingsSnapshot(event),
        repositoryCatalog: await getRequestRepositoryCatalogSnapshot(event),
      });
      setResponseStatus(event, response.status === "started" ? 201 : 202);
      return response;
    } catch (error) {
      toManualDispatchHttpError(error);
    }
  },
);
