import { createError, defineEventHandler } from "h3";
import type { WorkflowDefinitionDetailResponse } from "@shared/contracts";
import { getDb } from "../../../../db/client.js";
import { requireDashboardActor, toHttpError } from "../../../../lib/auth/request-context.js";
import {
  getWorkflowDefinition,
  getWorkflowDefinitionDraft,
  getDeployedWorkflowDefinitionVersion,
  listWorkflowDefinitionVersionRows,
  serializeWorkflowDefinitionVersion,
} from "../../../../workflow-definition/store.js";
import { parseDefinitionId, serializeDefinitionMeta } from "../workflow-definitions.get.js";

export default defineEventHandler(
  async (event): Promise<WorkflowDefinitionDetailResponse | undefined> => {
    try {
      await requireDashboardActor(event);
      const id = parseDefinitionId(event);
      const dbHandle = getDb();

      const row = await getWorkflowDefinition(dbHandle, id);
      if (!row || row.archivedAt) {
        throw createError({ statusCode: 404, statusMessage: "Unknown definition" });
      }

      const [draft, deployedRow, versionRows] = await Promise.all([
        getWorkflowDefinitionDraft(dbHandle, id),
        getDeployedWorkflowDefinitionVersion(dbHandle, id),
        listWorkflowDefinitionVersionRows(dbHandle, id),
      ]);
      const versions = versionRows.map(serializeWorkflowDefinitionVersion);
      const deployed = deployedRow ? serializeWorkflowDefinitionVersion(deployedRow) : null;
      return {
        meta: serializeDefinitionMeta(row),
        draft: draft?.draft ?? null,
        layout: row.layout,
        deployed,
        current: deployed,
        versions,
      };
    } catch (error) {
      toHttpError(error);
    }
  },
);
