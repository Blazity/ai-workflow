import {
  createError,
  defineEventHandler,
  readBody,
} from "h3";
import type {
  WorkflowDefinitionDeploymentResponse,
  WorkflowDefinitionDeploymentValidationResponse,
} from "@shared/contracts";
import {
  parseRequestBody,
  workflowDefinitionRollbackRequestSchema,
} from "@shared/contracts";
import { requireDashboardActor } from "../../../../../services/auth/request-context.js";
import {
  selectWorkflowDefinitionVersion,
} from "../../../../../services/workflow-definitions/deployment.js";
import {
  serializeWorkflowDefinitionVersion,
} from "../../../../../services/workflow-definitions/definition-store.js";
import {
  parseDefinitionId,
  serializeDefinitionMeta,
  toWorkflowDefinitionWriteHttpError,
} from "../../workflow-definitions.get.js";

export default defineEventHandler(
  async (
    event,
  ): Promise<
    | WorkflowDefinitionDeploymentResponse
    | WorkflowDefinitionDeploymentValidationResponse
    | undefined
  > => {
    try {
      const actor = await requireDashboardActor(event);
      const id = parseDefinitionId(event);
      const parsed = parseRequestBody(
        workflowDefinitionRollbackRequestSchema,
        (await readBody(event).catch(() => null)) ?? {},
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }

      const selected = await selectWorkflowDefinitionVersion({
        definitionId: id,
        version: parsed.value.version,
        expectedDeployedVersion: parsed.value.expectedDeployedVersion,
        actor: { role: actor.role, userId: actor.userId },
      });
      return {
        meta: serializeDefinitionMeta(selected.definition),
        deployed: serializeWorkflowDefinitionVersion(selected.version),
      };
    } catch (error) {
      return toWorkflowDefinitionWriteHttpError(event, error);
    }
  },
);
