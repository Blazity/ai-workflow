import {
  createError,
  defineEventHandler,
  readBody,
  setResponseHeader,
} from "h3";
import {
  parseRequestBody,
  workflowDefinitionPromptPreviewRequestSchema,
} from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../../services/auth/index.js";
import {
  activeWorkflowDefinitionExists,
  previewWorkflowDefinitionPrompt,
} from "../../../../../services/workflow-definitions/index.js";
import { parseDefinitionId } from "../../workflow-definitions.get.js";

export default defineEventHandler(async (event) => {
  try {
    setResponseHeader(event, "Cache-Control", "private, no-store");
    const actor = await requireDashboardActor(event);
    const definitionId = parseDefinitionId(event);
    const parsed = parseRequestBody(
      workflowDefinitionPromptPreviewRequestSchema,
      (await readBody(event).catch(() => null)) ?? {},
    );
    if (!parsed.ok) {
      throw createError({ statusCode: 400, statusMessage: parsed.message });
    }

    if (!(await activeWorkflowDefinitionExists(definitionId))) {
      throw createError({
        statusCode: 404,
        statusMessage: "Unknown definition",
      });
    }
    const result = await previewWorkflowDefinitionPrompt({
      candidate: parsed.value.definition,
      blockId: parsed.value.blockId,
      organizationId: actor.organizationId,
    });
    if (!result.ok) {
      throw createError({
        statusCode: result.statusCode,
        statusMessage: result.message,
        data: { issues: result.issues },
      });
    }
    return result.preview;
  } catch (error) {
    if (error instanceof Error && "statusCode" in error) throw error;
    toHttpError(error);
  }
});
