import {
  createError,
  defineEventHandler,
  readBody,
  setResponseHeader,
} from "h3";
import { getDb } from "../../../../../db/client.js";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../../lib/auth/request-context.js";
import { workflowBlockRegistryContextFromEnv } from "../../../../../workflow-definition/models.js";
import { previewWorkflowPromptCandidate } from "../../../../../workflow-definition/prompt-preview.js";
import { getWorkflowDefinition } from "../../../../../workflow-definition/store.js";
import {
  parseDefinitionId,
} from "../../workflow-definitions.get.js";

interface PromptPreviewBody {
  definition?: unknown;
  blockId?: unknown;
}

export default defineEventHandler(async (event) => {
  try {
    setResponseHeader(event, "Cache-Control", "private, no-store");
    const actor = await requireDashboardActor(event);
    const definitionId = parseDefinitionId(event);
    const body =
      (await readBody<PromptPreviewBody>(event).catch(() => null)) ?? {};
    if (
      typeof body.blockId !== "string" ||
      body.blockId.trim() !== body.blockId ||
      body.blockId.length === 0
    ) {
      throw createError({
        statusCode: 400,
        statusMessage: "Invalid block id",
      });
    }

    const db = getDb();
    const stored = await getWorkflowDefinition(db, definitionId);
    if (!stored || stored.archivedAt !== null) {
      throw createError({
        statusCode: 404,
        statusMessage: "Unknown definition",
      });
    }
    const result = await previewWorkflowPromptCandidate(
      db,
      body.definition,
      body.blockId,
      workflowBlockRegistryContextFromEnv(),
      { organizationId: actor.organizationId },
    );
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
