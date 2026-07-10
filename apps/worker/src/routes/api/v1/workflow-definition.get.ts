import { defineEventHandler } from "h3";
import type { WorkflowDefinitionResponse } from "@shared/contracts";
import { env } from "../../../../env.js";
import { getDb } from "../../../db/client.js";
import { requireDashboardActor, toHttpError } from "../../../lib/auth/request-context.js";
import { defaultWorkflowDefinition } from "../../../workflow-definition/default.js";
import {
  buildWorkflowEditorOptions,
  fetchAvailableModels,
} from "../../../workflow-definition/models.js";
import {
  listWorkflowDefinitionVersions,
  serializeWorkflowDefinitionVersion,
} from "../../../workflow-definition/store.js";

export default defineEventHandler(
  async (event): Promise<WorkflowDefinitionResponse | undefined> => {
    try {
      await requireDashboardActor(event);
      const versions = (await listWorkflowDefinitionVersions(getDb())).map(
        serializeWorkflowDefinitionVersion,
      );
      return {
        current: versions[0] ?? null,
        versions,
        defaultDefinition: defaultWorkflowDefinition({ includeReview: env.ENABLE_REVIEW_PHASE }),
        options: buildWorkflowEditorOptions(await fetchAvailableModels()),
      };
    } catch (error) {
      toHttpError(error);
    }
  },
);
