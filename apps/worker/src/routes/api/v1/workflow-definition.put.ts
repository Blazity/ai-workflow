import { createError, defineEventHandler, readBody } from "h3";
import type { WorkflowDefinitionSaveResponse } from "@shared/contracts";
import { getDb } from "../../../db/client.js";
import { requireDashboardActor, toHttpError } from "../../../lib/auth/request-context.js";
import { dashboardUserLabel } from "../../../pre-pr-checks/store.js";
import {
  describeWorkflowDefinitionIssues,
  validateWorkflowGraph,
  workflowDefinitionSchema,
} from "../../../workflow-definition/schema.js";
import {
  getWorkflowDefinition,
  saveWorkflowDefinition,
  serializeWorkflowDefinitionVersion,
} from "../../../workflow-definition/store.js";
import { serializeDefinitionMeta } from "./workflow-definitions.get.js";

/**
 * Legacy single-definition shim, removed once the dashboard moves to the
 * multi-definition routes. Delegates to the store's default-definition wrapper
 * so a single-definition install behaves exactly as before.
 */
export default defineEventHandler(
  async (event): Promise<WorkflowDefinitionSaveResponse | undefined> => {
    try {
      const actor = await requireDashboardActor(event);
      const body = (await readBody<{ definition?: unknown }>(event).catch(() => null)) ?? {};
      const parsed = workflowDefinitionSchema.safeParse(body.definition);
      if (!parsed.success) {
        throw createError({
          statusCode: 400,
          statusMessage: `Invalid definition: ${describeWorkflowDefinitionIssues(parsed.error)}`,
        });
      }
      const issues = validateWorkflowGraph(parsed.data);
      if (issues.length > 0) {
        throw createError({
          statusCode: 400,
          statusMessage: `Invalid workflow: ${issues.join("; ")}`,
        });
      }
      const dbHandle = getDb();
      const saved = await saveWorkflowDefinition(dbHandle, {
        actorRole: actor.role,
        actorId: actor.userId,
        actorLabel: await dashboardUserLabel(dbHandle, actor.userId),
        definition: parsed.data,
      });
      const row = await getWorkflowDefinition(dbHandle, saved.definitionId);
      return {
        meta: serializeDefinitionMeta(row!, saved.version),
        version: serializeWorkflowDefinitionVersion(saved),
      };
    } catch (error) {
      toHttpError(error);
    }
  },
);
