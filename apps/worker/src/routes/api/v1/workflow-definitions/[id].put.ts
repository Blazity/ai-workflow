import { createError, defineEventHandler, readBody } from "h3";
import type { WorkflowDefinitionSaveResponse } from "@shared/contracts";
import {
  parseRequestBody,
  workflowDefinitionDraftSaveRequestSchema,
} from "@shared/contracts";
import { requireDashboardActor } from "../../../../services/auth/request-context.js";
import {
  saveWorkflowDefinitionDraftAndValidate,
} from "../../../../services/workflow-definitions/definition-authoring.js";
import {
  parseWorkflowDefinitionCandidate,
} from "../../../../services/workflow-definitions/definition-candidates.js";
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
      const body = (await readBody(event).catch(() => null)) ?? {};

      // The graph is checked before the revision, so a client sending both a
      // broken graph and a stale revision hears about the graph first.
      const candidate = parseWorkflowDefinitionCandidate(
        (body as { definition?: unknown }).definition,
      );
      if (!candidate.ok) {
        throw createError({ statusCode: 400, statusMessage: candidate.message });
      }
      const parsed = parseRequestBody(workflowDefinitionDraftSaveRequestSchema, body);
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }

      const saved = await saveWorkflowDefinitionDraftAndValidate({
        definitionId: id,
        definition: candidate.definition,
        expectedDraftRevision: parsed.value.expectedDraftRevision,
        actor: { role: actor.role, userId: actor.userId },
      });
      return {
        meta: serializeDefinitionMeta(saved.definition),
        draft: saved.draftRow.draft,
        validation: saved.validation,
        validationError: saved.validationError,
      };
    } catch (error) {
      toWorkflowDefinitionHttpError(error);
    }
  },
);
