import { createError, defineEventHandler, readBody } from "h3";
import type { WorkflowDefinitionDeploymentResponse } from "@shared/contracts";
import { getDb } from "../../../../../db/client.js";
import { requireDashboardActor } from "../../../../../lib/auth/request-context.js";
import { dashboardUserLabel } from "../../../../../pre-pr-checks/store.js";
import {
  deployWorkflowDefinition,
  serializeWorkflowDefinitionVersion,
} from "../../../../../workflow-definition/store.js";
import {
  parseDefinitionId,
  serializeDefinitionMeta,
  toWorkflowDefinitionHttpError,
} from "../../workflow-definitions.get.js";

interface DeployBody {
  expectedDraftRevision?: unknown;
  expectedDeployedVersion?: unknown;
}

export default defineEventHandler(
  async (event): Promise<WorkflowDefinitionDeploymentResponse | undefined> => {
    try {
      const actor = await requireDashboardActor(event);
      const id = parseDefinitionId(event);
      const body = (await readBody<DeployBody>(event).catch(() => null)) ?? {};
      if (
        typeof body.expectedDraftRevision !== "number" ||
        !Number.isInteger(body.expectedDraftRevision) ||
        body.expectedDraftRevision < 0
      ) {
        throw createError({ statusCode: 400, statusMessage: "Invalid draft revision" });
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
      const selected = await deployWorkflowDefinition(dbHandle, {
        definitionId: id,
        expectedDraftRevision: body.expectedDraftRevision,
        expectedDeployedVersion: body.expectedDeployedVersion,
        actor: {
          role: actor.role,
          id: actor.userId,
          label: await dashboardUserLabel(dbHandle, actor.userId),
        },
      });
      return {
        meta: serializeDefinitionMeta(selected.definition),
        deployed: serializeWorkflowDefinitionVersion(selected.version),
      };
    } catch (error) {
      toWorkflowDefinitionHttpError(error);
    }
  },
);
