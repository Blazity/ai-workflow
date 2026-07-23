import { createError, defineEventHandler, getRouterParam, type H3Event } from "h3";
import type { WorkflowDefinitionMeta, WorkflowDefinitionsResponse } from "@shared/contracts";
import { env } from "../../../../env.js";
import { getDb } from "../../../db/client.js";
import { getCurrentSystemHarnessProfileReference } from "../../../harness-profiles/store.js";
import { requireDashboardActor, toHttpError } from "../../../lib/auth/request-context.js";
import { defaultWorkflowDefinitionV2 } from "../../../workflow-definition/default.js";
import { workflowDefinitionTemplates } from "../../../workflow-definition/templates.js";
import {
  buildWorkflowEditorOptions,
  fetchAvailableModels,
  fetchTicketStatuses,
} from "../../../workflow-definition/models.js";
import {
  listWorkflowDefinitions,
  WorkflowDefinitionStoreError,
  type WorkflowDefinitionRow,
} from "../../../workflow-definition/store.js";

/** Serializes a definition row into the dashboard-facing meta. Shared with the
 *  detail/save/patch routes and the legacy shims. */
export function serializeDefinitionMeta(row: WorkflowDefinitionRow): WorkflowDefinitionMeta {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    triggerTypes: row.triggerTypes,
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
      const db = getDb();
      const definitions = (await listWorkflowDefinitions(db)).map((row) =>
        serializeDefinitionMeta(row),
      );
      const [models, ticketStatuses, profileReference] = await Promise.all([
        fetchAvailableModels(),
        fetchTicketStatuses(),
        getCurrentSystemHarnessProfileReference(db, env.AGENT_KIND),
      ]);
      return {
        definitions,
        templates: workflowDefinitionTemplates({
          includeReview: env.ENABLE_REVIEW_PHASE,
          provider: env.AGENT_KIND,
          profileReference,
        }),
        defaultDefinition: defaultWorkflowDefinitionV2({
          includeReview: env.ENABLE_REVIEW_PHASE,
          provider: env.AGENT_KIND,
          profileReference,
        }),
        options: buildWorkflowEditorOptions(models, ticketStatuses),
      };
    } catch (error) {
      toHttpError(error);
    }
  },
);
