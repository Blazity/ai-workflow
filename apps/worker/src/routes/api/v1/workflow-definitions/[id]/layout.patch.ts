import { createError, defineEventHandler, readBody } from "h3";
import type { WorkflowDefinitionLayoutResponse } from "@shared/contracts";
import {
  parseRequestBody,
  workflowDefinitionLayoutPatchRequestSchema,
} from "@shared/contracts";
import { requireDashboardActor } from "../../../../../services/auth/index.js";
import { saveWorkflowDefinitionLayoutRevision } from "../../../../../services/workflow-definitions/index.js";
import {
  parseDefinitionId,
  serializeDefinitionMeta,
  toWorkflowDefinitionHttpError,
} from "../../workflow-definitions.get.js";

export default defineEventHandler(
  async (event): Promise<WorkflowDefinitionLayoutResponse | undefined> => {
    try {
      const actor = await requireDashboardActor(event);
      const id = parseDefinitionId(event);
      const parsed = parseRequestBody(
        workflowDefinitionLayoutPatchRequestSchema,
        (await readBody(event).catch(() => null)) ?? {},
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }

      const updated = await saveWorkflowDefinitionLayoutRevision({
        definitionId: id,
        layout: parsed.value.layout,
        expectedLayoutRevision: parsed.value.expectedLayoutRevision,
        actor: { role: actor.role, userId: actor.userId },
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
