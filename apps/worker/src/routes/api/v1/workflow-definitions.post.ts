import {
  createError,
  defineEventHandler,
  readBody,
  setResponseHeader,
} from "h3";
import type { WorkflowDefinitionDetailResponse } from "@shared/contracts";
import {
  parseRequestBody,
  workflowDefinitionCreateRequestSchema,
} from "@shared/contracts";
import { requireDashboardActor } from "../../../services/auth/request-context.js";
import { canEditWorkflowDefinitions } from "../../../services/auth/roles.js";
import {
  createWorkflowDefinitionFromSource,
} from "../../../services/workflow-definitions/definition-authoring.js";
import {
  serializeWorkflowDefinitionVersion,
} from "../../../services/workflow-definitions/definition-store.js";
import {
  serializeDefinitionMeta,
  toWorkflowDefinitionHttpError,
} from "./workflow-definitions.get.js";

export default defineEventHandler(
  async (
    event,
  ): Promise<WorkflowDefinitionDetailResponse | undefined> => {
    try {
      setResponseHeader(event, "Cache-Control", "private, no-store");
      const actor = await requireDashboardActor(event);
      if (!canEditWorkflowDefinitions(actor.role)) {
        throw createError({ statusCode: 403, statusMessage: "Forbidden" });
      }
      const parsed = parseRequestBody(
        workflowDefinitionCreateRequestSchema,
        (await readBody(event).catch(() => null)) ?? {},
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }

      const created = await createWorkflowDefinitionFromSource({
        name: parsed.value.name,
        source: parsed.value.source,
        actor: { role: actor.role, userId: actor.userId },
      });
      if (!created.ok) {
        throw created.reason === "unknown_definition"
          ? createError({ statusCode: 404, statusMessage: "Unknown definition" })
          : createError({ statusCode: 400, statusMessage: "Unknown template" });
      }

      return {
        meta: serializeDefinitionMeta(created.definition),
        draft: created.draft,
        layout: created.definition.layout,
        deployed: null,
        current: null,
        versions: created.currentVersion
          ? [serializeWorkflowDefinitionVersion(created.currentVersion)]
          : [],
      };
    } catch (error) {
      toWorkflowDefinitionHttpError(error);
    }
  },
);
