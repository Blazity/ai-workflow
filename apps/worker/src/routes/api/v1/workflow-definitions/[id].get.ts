import { createError, defineEventHandler } from "h3";
import type { WorkflowDefinitionDetailResponse } from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../services/auth/request-context.js";
import {
  readWorkflowDefinitionDetail,
  serializeWorkflowDefinitionVersion,
} from "../../../../services/workflow-definitions/index.js";
import {
  parseDefinitionId,
  serializeDefinitionMeta,
} from "../workflow-definitions.get.js";

export default defineEventHandler(
  async (event): Promise<WorkflowDefinitionDetailResponse | undefined> => {
    try {
      await requireDashboardActor(event);
      const id = parseDefinitionId(event);

      const detail = await readWorkflowDefinitionDetail(id);
      if (!detail) {
        throw createError({ statusCode: 404, statusMessage: "Unknown definition" });
      }

      const versions = detail.versionRows.map(serializeWorkflowDefinitionVersion);
      const deployed = detail.deployedRow
        ? serializeWorkflowDefinitionVersion(detail.deployedRow)
        : null;
      return {
        meta: serializeDefinitionMeta(detail.row),
        draft: detail.draft?.draft ?? null,
        layout: detail.row.layout,
        deployed,
        current: deployed,
        versions,
      };
    } catch (error) {
      toHttpError(error);
    }
  },
);
