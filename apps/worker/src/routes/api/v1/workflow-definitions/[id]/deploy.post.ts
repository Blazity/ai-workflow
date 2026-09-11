import { createError, defineEventHandler, readBody } from "h3";
import type {
  WorkflowDefinitionDeploymentResponse,
  WorkflowDefinitionDeploymentValidationResponse,
} from "@shared/contracts";
import {
  parseRequestBody,
  workflowDefinitionDeployRequestSchema,
} from "@shared/contracts";
import { requireDashboardActor } from "../../../../../services/auth/request-context.js";
import {
  deployWorkflowDefinitionDraft,
  serializeWorkflowDefinitionVersion,
} from "../../../../../services/workflow-definitions/index.js";
import {
  parseDefinitionId,
  serializeDefinitionMeta,
  toWorkflowDefinitionWriteHttpError,
} from "../../workflow-definitions.get.js";

export default defineEventHandler(
  async (
    event,
  ): Promise<
    WorkflowDefinitionDeploymentResponse | WorkflowDefinitionDeploymentValidationResponse | undefined
  > => {
    try {
      const actor = await requireDashboardActor(event);
      const id = parseDefinitionId(event);
      const parsed = parseRequestBody(
        workflowDefinitionDeployRequestSchema,
        (await readBody(event).catch(() => null)) ?? {},
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }

      const selected = await deployWorkflowDefinitionDraft({
        definitionId: id,
        expectedDraftRevision: parsed.value.expectedDraftRevision,
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
