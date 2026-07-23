import type {
  ManualDispatchInput,
  ManualDispatchPreflightResponse,
} from "@shared/contracts";
import {
  createError,
  defineEventHandler,
  getRouterParam,
  readBody,
} from "h3";
import { env } from "../../../../../../../../../env.js";
import { getDb } from "../../../../../../../../db/client.js";
import { createAdapters } from "../../../../../../../../lib/adapters.js";
import { requireDashboardActor } from "../../../../../../../../lib/auth/request-context.js";
import { canDispatchWorkflowRuns } from "../../../../../../../../lib/auth/roles.js";
import {
  parseManualDispatchInput,
  toManualDispatchHttpError,
} from "../../../../../../../../manual-dispatch/http.js";
import { preflightManualDispatch } from "../../../../../../../../manual-dispatch/service.js";
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
      const dispatchInput = parseManualDispatchInput(
        await readBody<ManualDispatchInput>(event).catch(() => null),
      );
      return await preflightManualDispatch({
        db: getDb(),
        adapters: createAdapters(),
        definitionId,
        triggerNodeId,
        dispatchInput,
        maxConcurrentAgents: env.MAX_CONCURRENT_AGENTS,
      });
    } catch (error) {
      toManualDispatchHttpError(error);
    }
  },
);
