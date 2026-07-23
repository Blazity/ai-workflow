import { defineEventHandler, readBody } from "h3";
import type { WorkflowDefinitionValidationResponse } from "@shared/contracts";
import { requireDashboardActor, toHttpError } from "../../../../../lib/auth/request-context.js";
import { workflowBlockRegistryContextFromEnv } from "../../../../../workflow-definition/models.js";
import { validateWorkflowDefinitionCandidate } from "../../../../../workflow-definition/validation.js";

export default defineEventHandler(
  async (event): Promise<WorkflowDefinitionValidationResponse | undefined> => {
    try {
      await requireDashboardActor(event);
      const body = (await readBody<{ definition?: unknown }>(event).catch(() => null)) ?? {};
      return validateWorkflowDefinitionCandidate(
        body.definition,
        workflowBlockRegistryContextFromEnv(),
      ).response;
    } catch (error) {
      if (error instanceof Error && "statusCode" in error) throw error;
      toHttpError(error);
    }
  },
);
