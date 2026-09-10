import {
  createError,
  defineEventHandler,
  readBody,
  setResponseHeader,
} from "h3";
import type { WorkflowDefinitionCatalogResponse } from "@shared/contracts";
import {
  parseRequestBody,
  workflowDefinitionCandidateRequestSchema,
} from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../../services/auth/index.js";
import {
  activeWorkflowDefinitionExists,
  analyzeWorkflowDefinitionCatalog,
  parseWorkflowDefinitionCandidate,
} from "../../../../../services/workflow-definitions/index.js";
import { parseDefinitionId } from "../../workflow-definitions.get.js";

export default defineEventHandler(
  async (event): Promise<WorkflowDefinitionCatalogResponse | undefined> => {
    try {
      setResponseHeader(event, "Cache-Control", "private, no-store");
      await requireDashboardActor(event);
      const definitionId = parseDefinitionId(event);
      if (!(await activeWorkflowDefinitionExists(definitionId))) {
        throw createError({
          statusCode: 404,
          statusMessage: "Unknown definition",
        });
      }
      const parsed = parseRequestBody(
        workflowDefinitionCandidateRequestSchema,
        (await readBody(event).catch(() => null)) ?? {},
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }
      const candidate = parseWorkflowDefinitionCandidate(parsed.value.definition);
      if (!candidate.ok) {
        // One flat message whatever the candidate is wrong about: the catalog
        // panel has nowhere to show per-node issues, and the validate route is
        // where a client goes for those.
        throw createError({
          statusCode: 400,
          statusMessage: "Invalid v2 definition",
        });
      }
      return analyzeWorkflowDefinitionCatalog(candidate.definition);
    } catch (error) {
      if (error instanceof Error && "statusCode" in error) throw error;
      toHttpError(error);
    }
  },
);
