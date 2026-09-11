import {
  createError,
  defineEventHandler,
  getRouterParam,
  setResponseStatus,
  type H3Event,
} from "h3";
import type {
  WorkflowDefinitionDeploymentValidationResponse,
  WorkflowDefinitionMeta,
  WorkflowDefinitionsResponse,
} from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../services/auth/request-context.js";
import {
  readWorkflowDefinitionsOverview,
  WorkflowDefinitionStoreError,
  WorkflowDefinitionValidationError,
  type WorkflowDefinitionRow,
} from "../../../services/workflow-definitions/index.js";

/** Serializes a definition row into the dashboard-facing meta. Shared with the
 *  detail/save/patch routes and the legacy shims. */
export function serializeDefinitionMeta(row: WorkflowDefinitionRow): WorkflowDefinitionMeta {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    deployedSchema: row.deployedSchema,
    ...(row.retiredMessage ? { retiredMessage: row.retiredMessage } : {}),
    triggerTypes: row.deployedSchema === "legacy-v1" ? [] : row.triggerTypes,
    currentVersion: row.draftRevision || null,
    draftRevision: row.draftRevision,
    layoutRevision: row.layoutRevision,
    deployedVersion: row.deployedVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Maps a store write failure (409/404) to its HTTP error, then defers the rest
 *  (403 DashboardAuthError, etc.) to the shared toHttpError. */
export function toWorkflowDefinitionHttpError(error: unknown): never {
  if (error instanceof WorkflowDefinitionStoreError) {
    throw createError({ statusCode: error.statusCode, statusMessage: error.message });
  }
  toHttpError(error);
}

export function toWorkflowDefinitionWriteHttpError(
  event: H3Event,
  error: unknown,
): WorkflowDefinitionDeploymentValidationResponse | never {
  if (error instanceof WorkflowDefinitionValidationError) {
    setResponseStatus(event, 422, error.message);
    return { error: error.message, issues: error.issues };
  }
  return toWorkflowDefinitionHttpError(error);
}

/** Reads and validates the `[id]` route segment shared by the detail routes. */
export function parseDefinitionId(event: H3Event): number {
  const id = Number(getRouterParam(event, "id"));
  if (!Number.isInteger(id) || id <= 0 || id > 2147483647) {
    throw createError({ statusCode: 404, statusMessage: "Unknown definition" });
  }
  return id;
}

export default defineEventHandler(
  async (event): Promise<WorkflowDefinitionsResponse | undefined> => {
    try {
      await requireDashboardActor(event);
      const overview = await readWorkflowDefinitionsOverview();
      return {
        definitions: overview.definitions.map((row) => serializeDefinitionMeta(row)),
        templates: overview.templates,
        defaultDefinition: overview.defaultDefinition,
        options: overview.options,
      };
    } catch (error) {
      toHttpError(error);
    }
  },
);
