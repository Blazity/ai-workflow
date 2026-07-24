import {
  createError,
  defineEventHandler,
  readBody,
  setResponseHeader,
} from "h3";
import type {
  WorkflowDefinitionCatalogResponse,
  WorkflowDefinitionV2,
} from "@shared/contracts";
import { getDb } from "../../../../../db/client.js";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../../lib/auth/request-context.js";
import { analyzeWorkflowV2Catalog } from "../../../../../workflow-definition/available-values.js";
import { workflowBlockRegistryContextFromEnv } from "../../../../../workflow-definition/models.js";
import { workflowDefinitionV2Schema } from "../../../../../workflow-definition/schema.js";
import { getWorkflowDefinition } from "../../../../../workflow-definition/store.js";
import { parseDefinitionId } from "../../workflow-definitions.get.js";

export default defineEventHandler(
  async (event): Promise<WorkflowDefinitionCatalogResponse | undefined> => {
    try {
      setResponseHeader(event, "Cache-Control", "private, no-store");
      await requireDashboardActor(event);
      const definitionId = parseDefinitionId(event);
      const stored = await getWorkflowDefinition(getDb(), definitionId);
      if (!stored || stored.archivedAt !== null) {
        throw createError({
          statusCode: 404,
          statusMessage: "Unknown definition",
        });
      }
      const body =
        (await readBody<{ definition?: unknown }>(event).catch(() => null)) ??
        {};
      const parsed = workflowDefinitionV2Schema.safeParse(body.definition);
      if (!parsed.success) {
        throw createError({
          statusCode: 400,
          statusMessage: "Invalid v2 definition",
        });
      }
      return analyzeWorkflowV2Catalog(
        parsed.data as WorkflowDefinitionV2,
        workflowBlockRegistryContextFromEnv(),
      );
    } catch (error) {
      if (error instanceof Error && "statusCode" in error) throw error;
      toHttpError(error);
    }
  },
);
