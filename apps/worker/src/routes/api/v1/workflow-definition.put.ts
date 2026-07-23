import { createError, defineEventHandler, readBody } from "h3";
import type { WorkflowDefinitionSaveResponse } from "@shared/contracts";
import { getDb } from "../../../db/client.js";
import { requireDashboardActor } from "../../../lib/auth/request-context.js";
import { logger } from "../../../lib/logger.js";
import { dashboardUserLabel } from "../../../pre-pr-checks/store.js";
import { workflowBlockRegistryContextFromEnv } from "../../../workflow-definition/models.js";
import {
  describeWorkflowDefinitionIssues,
  workflowDefinitionSchema,
} from "../../../workflow-definition/schema.js";
import {
  resolveDefaultDefinitionId,
  saveWorkflowDefinitionDraft,
} from "../../../workflow-definition/store.js";
import { validateWorkflowDefinitionCandidateWithPromptAuthoring } from "../../../workflow-definition/prompt-authoring.js";
import {
  serializeDefinitionMeta,
  toWorkflowDefinitionHttpError,
} from "./workflow-definitions.get.js";

/**
 * Legacy single-definition shim, removed once the dashboard moves to the
 * multi-definition routes. Delegates to the store's default-definition wrapper
 * so a single-definition install behaves exactly as before.
 */
export default defineEventHandler(
  async (event): Promise<WorkflowDefinitionSaveResponse | undefined> => {
    try {
      const actor = await requireDashboardActor(event);
      const body = (await readBody<{ definition?: unknown; expectedDraftRevision?: unknown }>(event).catch(() => null)) ?? {};
      const parsed = workflowDefinitionSchema.safeParse(body.definition);
      if (!parsed.success) {
        throw createError({
          statusCode: 400,
          statusMessage: `Invalid definition: ${describeWorkflowDefinitionIssues(parsed.error)}`,
        });
      }
      if (
        typeof body.expectedDraftRevision !== "number" ||
        !Number.isInteger(body.expectedDraftRevision) ||
        body.expectedDraftRevision < 0
      ) {
        throw createError({ statusCode: 400, statusMessage: "Invalid draft revision" });
      }
      const dbHandle = getDb();
      const definitionId = await resolveDefaultDefinitionId(dbHandle);
      const saved = await saveWorkflowDefinitionDraft(dbHandle, {
        definitionId,
        definition: parsed.data,
        expectedDraftRevision: body.expectedDraftRevision,
        actor: {
          role: actor.role,
          id: actor.userId,
          label: await dashboardUserLabel(dbHandle, actor.userId),
        },
      });
      let validation: WorkflowDefinitionSaveResponse["validation"] = null;
      let validationError: string | null = null;
      try {
        validation = (await validateWorkflowDefinitionCandidateWithPromptAuthoring(
          dbHandle,
          saved.draft,
          workflowBlockRegistryContextFromEnv(),
        )).response;
      } catch (validationFailure) {
        validationError = "Validation is temporarily unavailable. Your draft was saved.";
        logger.warn(
          {
            definitionId,
            draftRevision: saved.draftRevision,
            error:
              validationFailure instanceof Error
                ? validationFailure.message
                : String(validationFailure),
          },
          "workflow_draft_validation_failed_after_save",
        );
      }
      return {
        meta: serializeDefinitionMeta(saved.definition),
        draft: saved.draft,
        validation,
        validationError,
      };
    } catch (error) {
      toWorkflowDefinitionHttpError(error);
    }
  },
);
