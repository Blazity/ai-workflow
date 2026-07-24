import {
  createError,
  defineEventHandler,
  readBody,
} from "h3";
import type {
  WorkflowDefinitionDeploymentResponse,
  WorkflowDefinitionDeploymentValidationResponse,
} from "@shared/contracts";
import { getDb } from "../../../../db/client.js";
import { requireDashboardActor } from "../../../../lib/auth/request-context.js";
import { dashboardUserLabel } from "../../../../pre-pr-checks/store.js";
import {
  resolveDefaultDefinitionId,
  rollbackWorkflowDefinition,
  serializeWorkflowDefinitionVersion,
} from "../../../../workflow-definition/store.js";
import {
  serializeDefinitionMeta,
  toWorkflowDefinitionWriteHttpError,
} from "../workflow-definitions.get.js";

/**
 * Legacy single-definition shim, removed once the dashboard moves to the
 * multi-definition routes. Delegates to the store's default-definition wrapper
 * so a single-definition install behaves exactly as before.
 */
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
      const body = (await readBody<{ version?: unknown; expectedDeployedVersion?: unknown }>(event).catch(() => null)) ?? {};
      if (typeof body.version !== "number" || !Number.isInteger(body.version)) {
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
      const definitionId = await resolveDefaultDefinitionId(dbHandle);
      const restored = await rollbackWorkflowDefinition(dbHandle, {
        definitionId,
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
      return toWorkflowDefinitionWriteHttpError(event, error);
    }
  },
);
