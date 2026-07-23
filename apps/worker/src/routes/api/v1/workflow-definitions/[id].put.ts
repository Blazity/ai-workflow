import { createError, defineEventHandler, readBody } from "h3";
import type { WorkflowDefinitionSaveResponse } from "@shared/contracts";
import { getDb } from "../../../../db/client.js";
import { requireDashboardActor } from "../../../../lib/auth/request-context.js";
import { logger } from "../../../../lib/logger.js";
import { dashboardUserLabel } from "../../../../pre-pr-checks/store.js";
import {
  describeWorkflowDefinitionIssues,
  workflowDefinitionSchema,
} from "../../../../workflow-definition/schema.js";
import { workflowBlockRegistryContextFromEnv } from "../../../../workflow-definition/models.js";
import {
  saveWorkflowDefinitionDraft,
} from "../../../../workflow-definition/store.js";
import { validateWorkflowDefinitionCandidate } from "../../../../workflow-definition/validation.js";
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
      const saved = await saveWorkflowDefinitionDraft(dbHandle, {
        definitionId: id,
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
        validation = validateWorkflowDefinitionCandidate(
          saved.draft,
          workflowBlockRegistryContextFromEnv(),
        ).response;
      } catch (validationFailure) {
        validationError = "Validation is temporarily unavailable. Your draft was saved.";
        logger.warn(
          {
            definitionId: id,
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
