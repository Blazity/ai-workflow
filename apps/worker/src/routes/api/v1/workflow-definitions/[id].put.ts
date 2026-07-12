import { createError, defineEventHandler, readBody } from "h3";
import type { WorkflowDefinitionSaveResponse } from "@shared/contracts";
import { getDb } from "../../../../db/client.js";
import { requireDashboardActor } from "../../../../lib/auth/request-context.js";
import { dashboardUserLabel } from "../../../../pre-pr-checks/store.js";
import {
  describeWorkflowDefinitionIssues,
  validateWorkflowGraph,
  workflowDefinitionSchema,
} from "../../../../workflow-definition/schema.js";
import {
  getWorkflowDefinition,
  saveWorkflowDefinitionVersion,
  serializeWorkflowDefinitionVersion,
} from "../../../../workflow-definition/store.js";
import {
  parseDefinitionId,
  serializeDefinitionMeta,
  toWorkflowDefinitionHttpError,
} from "../workflow-definitions.get.js";

export default defineEventHandler(
  async (event): Promise<WorkflowDefinitionSaveResponse | undefined> => {
    try {
      const actor = await requireDashboardActor(event);
      const id = parseDefinitionId(event);
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
      const saved = await saveWorkflowDefinitionVersion(dbHandle, {
        definitionId: id,
        definition: parsed.data,
        actor: {
          role: actor.role,
          id: actor.userId,
          label: await dashboardUserLabel(dbHandle, actor.userId),
        },
      });
      const row = await getWorkflowDefinition(dbHandle, id);
      return {
        meta: serializeDefinitionMeta(row!, saved.version),
        version: serializeWorkflowDefinitionVersion(saved),
      };
    } catch (error) {
      toWorkflowDefinitionHttpError(error);
    }
  },
);
