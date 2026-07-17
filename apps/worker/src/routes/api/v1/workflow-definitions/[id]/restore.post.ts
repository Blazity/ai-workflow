import { createError, defineEventHandler, readBody } from "h3";
import type { WorkflowDefinitionSaveResponse } from "@shared/contracts";
import { getDb } from "../../../../../db/client.js";
import { requireDashboardActor } from "../../../../../lib/auth/request-context.js";
import { dashboardUserLabel } from "../../../../../pre-pr-checks/store.js";
import {
  getWorkflowDefinition,
  restoreWorkflowDefinitionVersion,
  serializeWorkflowDefinitionVersion,
} from "../../../../../workflow-definition/store.js";
import {
  parseDefinitionId,
  serializeDefinitionMeta,
  toWorkflowDefinitionHttpError,
} from "../../workflow-definitions.get.js";

export default defineEventHandler(
  async (event): Promise<WorkflowDefinitionSaveResponse | undefined> => {
    try {
      const actor = await requireDashboardActor(event);
      const id = parseDefinitionId(event);
      const body = (await readBody<{ version?: unknown }>(event).catch(() => null)) ?? {};
      if (typeof body.version !== "number" || !Number.isInteger(body.version)) {
        throw createError({ statusCode: 400, statusMessage: "Invalid version" });
      }

      const dbHandle = getDb();
      const restored = await restoreWorkflowDefinitionVersion(dbHandle, {
        definitionId: id,
        version: body.version,
        actor: {
          role: actor.role,
          id: actor.userId,
          label: await dashboardUserLabel(dbHandle, actor.userId),
        },
      });
      const row = await getWorkflowDefinition(dbHandle, id);
      return {
        meta: serializeDefinitionMeta(row!, restored.version),
        version: serializeWorkflowDefinitionVersion(restored),
      };
    } catch (error) {
      toWorkflowDefinitionHttpError(error);
    }
  },
);
