import { createError, defineEventHandler, readBody } from "h3";
import type {
  WorkflowDefinitionLayoutInput,
  WorkflowDefinitionLayoutResponse,
} from "@shared/contracts";
import { getDb } from "../../../../../db/client.js";
import { requireDashboardActor } from "../../../../../lib/auth/request-context.js";
import { dashboardUserLabel } from "../../../../../pre-pr-checks/store.js";
import { saveWorkflowDefinitionLayout } from "../../../../../workflow-definition/store.js";
import {
  parseDefinitionId,
  serializeDefinitionMeta,
  toWorkflowDefinitionHttpError,
} from "../../workflow-definitions.get.js";

interface LayoutBody {
  layout?: unknown;
  expectedLayoutRevision?: unknown;
}

export default defineEventHandler(
  async (event): Promise<WorkflowDefinitionLayoutResponse | undefined> => {
    try {
      const actor = await requireDashboardActor(event);
      const id = parseDefinitionId(event);
      const body = (await readBody<LayoutBody>(event).catch(() => null)) ?? {};
      if (!body.layout || typeof body.layout !== "object") {
        throw createError({ statusCode: 400, statusMessage: "Invalid workflow layout" });
      }
      if (
        typeof body.expectedLayoutRevision !== "number" ||
        !Number.isInteger(body.expectedLayoutRevision) ||
        body.expectedLayoutRevision < 0
      ) {
        throw createError({ statusCode: 400, statusMessage: "Invalid layout revision" });
      }

      const dbHandle = getDb();
      const updated = await saveWorkflowDefinitionLayout(dbHandle, {
        definitionId: id,
        layout: body.layout as WorkflowDefinitionLayoutInput,
        expectedLayoutRevision: body.expectedLayoutRevision,
        actor: {
          role: actor.role,
          id: actor.userId,
          label: await dashboardUserLabel(dbHandle, actor.userId),
        },
      });
      return {
        meta: serializeDefinitionMeta(updated),
        layout: updated.layout,
      };
    } catch (error) {
      toWorkflowDefinitionHttpError(error);
    }
  },
);
