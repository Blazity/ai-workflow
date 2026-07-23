import { defineEventHandler, readBody, setResponseHeader } from "h3";
import type { WorkflowDefinitionValidationResponse } from "@shared/contracts";
import { getDb } from "../../../../../db/client.js";
import { requireDashboardActor, toHttpError } from "../../../../../lib/auth/request-context.js";
import { workflowBlockRegistryContextFromEnv } from "../../../../../workflow-definition/models.js";
import { validateWorkflowDefinitionCandidateWithPromptAuthoring } from "../../../../../workflow-definition/prompt-authoring.js";

export default defineEventHandler(
  async (event): Promise<WorkflowDefinitionValidationResponse | undefined> => {
    try {
      setResponseHeader(event, "Cache-Control", "private, no-store");
      await requireDashboardActor(event);
      const body = (await readBody<{ definition?: unknown }>(event).catch(() => null)) ?? {};
      return (await validateWorkflowDefinitionCandidateWithPromptAuthoring(
        getDb(),
        body.definition,
        workflowBlockRegistryContextFromEnv(),
      )).response;
    } catch (error) {
      if (error instanceof Error && "statusCode" in error) throw error;
      toHttpError(error);
    }
  },
);
