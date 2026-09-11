import { createError, defineEventHandler, readBody, setResponseHeader } from "h3";
import type { WorkflowDefinitionValidationResponse } from "@shared/contracts";
import {
  parseRequestBody,
  workflowDefinitionCandidateRequestSchema,
} from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../../services/auth/request-context.js";
import {
  validateWorkflowDefinitionDraftCandidate,
} from "../../../../../services/workflow-definitions/definition-candidates.js";

export default defineEventHandler(
  async (event): Promise<WorkflowDefinitionValidationResponse | undefined> => {
    try {
      setResponseHeader(event, "Cache-Control", "private, no-store");
      await requireDashboardActor(event);
      const parsed = parseRequestBody(
        workflowDefinitionCandidateRequestSchema,
        (await readBody(event).catch(() => null)) ?? {},
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }
      return await validateWorkflowDefinitionDraftCandidate(parsed.value.definition);
    } catch (error) {
      if (error instanceof Error && "statusCode" in error) throw error;
      toHttpError(error);
    }
  },
);
