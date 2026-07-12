import { createError, defineEventHandler } from "h3";
import type { WorkflowDefinitionDetailResponse } from "@shared/contracts";
import { getDb } from "../../../../db/client.js";
import { requireDashboardActor, toHttpError } from "../../../../lib/auth/request-context.js";
import {
  getWorkflowDefinition,
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

      const versions = (await listWorkflowDefinitionVersionRows(dbHandle, id)).map(
        serializeWorkflowDefinitionVersion,
      );
      const current = versions[0] ?? null;
      return {
        meta: serializeDefinitionMeta(row, current?.version ?? null),
        current,
        versions,
      };
    } catch (error) {
      toHttpError(error);
    }
  },
);
