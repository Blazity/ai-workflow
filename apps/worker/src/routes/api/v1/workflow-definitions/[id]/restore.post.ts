import {
  createError,
  defineEventHandler,
  readBody,
  setResponseStatus,
} from "h3";
import type {
  WorkflowDefinitionDeploymentResponse,
  WorkflowDefinitionDeploymentValidationResponse,
} from "@shared/contracts";
import { getDb } from "../../../../../db/client.js";
import { requireDashboardActor } from "../../../../../lib/auth/request-context.js";
import { dashboardUserLabel } from "../../../../../pre-pr-checks/store.js";
import {
  rollbackWorkflowDefinition,
  serializeWorkflowDefinitionVersion,
  WorkflowDefinitionValidationError,
} from "../../../../../workflow-definition/store.js";
import {
  parseDefinitionId,
  serializeDefinitionMeta,
  toWorkflowDefinitionHttpError,
} from "../../workflow-definitions.get.js";

export default defineEventHandler(
  async (
    event,
  ): Promise<
    | WorkflowDefinitionDeploymentResponse
    | WorkflowDefinitionDeploymentValidationResponse
    | undefined
  > => {
    try {
      const actor = await requireDashboardActor(event);
      const id = parseDefinitionId(event);
      const body = (await readBody<{ version?: unknown; expectedDeployedVersion?: unknown }>(event).catch(() => null)) ?? {};
      if (
        typeof body.version !== "number" ||
        !Number.isInteger(body.version) ||
        body.version <= 0
      ) {
        throw createError({ statusCode: 400, statusMessage: "Invalid version" });
      }
      if (
        body.expectedDeployedVersion !== null &&
        (typeof body.expectedDeployedVersion !== "number" ||
          !Number.isInteger(body.expectedDeployedVersion) ||
          body.expectedDeployedVersion <= 0)
      ) {
        throw createError({ statusCode: 400, statusMessage: "Invalid deployed version" });
      }

      const dbHandle = getDb();
      const restored = await rollbackWorkflowDefinition(dbHandle, {
        definitionId: id,
        version: body.version,
        expectedDeployedVersion: body.expectedDeployedVersion,
        actor: {
          role: actor.role,
          id: actor.userId,
          label: await dashboardUserLabel(dbHandle, actor.userId),
        },
      });
      return {
        meta: serializeDefinitionMeta(restored.definition),
        deployed: serializeWorkflowDefinitionVersion(restored.version),
      };
    } catch (error) {
      if (error instanceof WorkflowDefinitionValidationError) {
        setResponseStatus(event, 422, error.message);
        return { error: error.message, issues: error.issues };
      }
      toWorkflowDefinitionHttpError(error);
    }
  },
);
