import { defineEventHandler, readBody } from "h3";
import type { WorkflowDefinitionValidationResponse } from "@shared/contracts";
import { requireDashboardActor, toHttpError } from "../../../../../lib/auth/request-context.js";
import { workflowBlockRegistryContextFromEnv } from "../../../../../workflow-definition/models.js";
import {
  describeWorkflowDefinitionIssues,
  validateWorkflowDefinitionForDeployment,
  workflowDefinitionSchema,
} from "../../../../../workflow-definition/schema.js";

export default defineEventHandler(
  async (event): Promise<WorkflowDefinitionValidationResponse | undefined> => {
    try {
      await requireDashboardActor(event);
      const body = (await readBody<{ definition?: unknown }>(event).catch(() => null)) ?? {};
      const parsed = workflowDefinitionSchema.safeParse(body.definition);
      if (!parsed.success) {
        return {
          valid: false,
          issues: [`Invalid definition: ${describeWorkflowDefinitionIssues(parsed.error)}`],
        };
      }
      const issues = validateWorkflowDefinitionForDeployment(
        parsed.data,
        workflowBlockRegistryContextFromEnv(),
      );
      return { valid: issues.length === 0, issues };
    } catch (error) {
      if (error instanceof Error && "statusCode" in error) throw error;
      toHttpError(error);
    }
  },
);
