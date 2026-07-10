import { createError, defineEventHandler, readBody } from "h3";
import type { WorkflowDefinitionSaveResponse } from "@shared/contracts";
import { getDb } from "../../../../db/client.js";
import { requireDashboardActor, toHttpError } from "../../../../lib/auth/request-context.js";
import { dashboardUserLabel } from "../../../../pre-pr-checks/store.js";
import {
  restoreWorkflowDefinition,
  serializeWorkflowDefinitionVersion,
} from "../../../../workflow-definition/store.js";

export default defineEventHandler(
  async (event): Promise<WorkflowDefinitionSaveResponse | undefined> => {
    try {
      const actor = await requireDashboardActor(event);
      const body = (await readBody<{ version?: unknown }>(event).catch(() => null)) ?? {};
      if (typeof body.version !== "number" || !Number.isInteger(body.version)) {
        throw createError({ statusCode: 400, statusMessage: "Invalid version" });
      }
      const dbHandle = getDb();
      const restored = await restoreWorkflowDefinition(dbHandle, {
        actorRole: actor.role,
        actorId: actor.userId,
        actorLabel: await dashboardUserLabel(dbHandle, actor.userId),
        version: body.version,
      });
      return { version: serializeWorkflowDefinitionVersion(restored) };
    } catch (error) {
      toHttpError(error);
    }
  },
);
