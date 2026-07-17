import { createError, defineEventHandler, readBody } from "h3";
import type { WorkflowDefinitionMeta } from "@shared/contracts";
import { getDb } from "../../../../db/client.js";
import { requireDashboardActor } from "../../../../lib/auth/request-context.js";
import { dashboardUserLabel } from "../../../../pre-pr-checks/store.js";
import { updateWorkflowDefinition } from "../../../../workflow-definition/store.js";
import {
  parseDefinitionId,
  serializeDefinitionMeta,
  toWorkflowDefinitionHttpError,
} from "../workflow-definitions.get.js";

interface PatchBody {
  name?: unknown;
  enabled?: unknown;
}

export default defineEventHandler(
  async (event): Promise<WorkflowDefinitionMeta | undefined> => {
    try {
      const actor = await requireDashboardActor(event);
      const id = parseDefinitionId(event);
      const body = (await readBody<PatchBody>(event).catch(() => null)) ?? {};

      let name: string | undefined;
      if (body.name !== undefined) {
        if (typeof body.name !== "string" || body.name.trim().length === 0) {
          throw createError({ statusCode: 400, statusMessage: "Invalid name" });
        }
        name = body.name.trim();
      }
      let enabled: boolean | undefined;
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== "boolean") {
          throw createError({ statusCode: 400, statusMessage: "Invalid enabled" });
        }
        enabled = body.enabled;
      }

      const dbHandle = getDb();
      const updated = await updateWorkflowDefinition(dbHandle, {
        definitionId: id,
        name,
        enabled,
        actor: {
          role: actor.role,
          id: actor.userId,
          label: await dashboardUserLabel(dbHandle, actor.userId),
        },
      });
      return serializeDefinitionMeta(updated, updated.deployedVersion);
    } catch (error) {
      toWorkflowDefinitionHttpError(error);
    }
  },
);
