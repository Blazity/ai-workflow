import { createError, defineEventHandler, readBody } from "h3";
import type {
  WorkflowDefinitionDeploymentResponse,
  WorkflowDefinitionDeploymentValidationResponse,
} from "@shared/contracts";
import {
  parseRequestBody,
  workflowDefinitionDeployRequestSchema,
} from "@shared/contracts";
import { requireDashboardActor } from "../../../../../services/auth/request-context.js";
import {
  getRequestRepositoryCatalogSnapshot,
  pinnedRepositoriesNotEnabled,
} from "../../../../../services/repository-catalog/index.js";
import {
  deployWorkflowDefinitionDraft,
} from "../../../../../services/workflow-definitions/deployment.js";
import {
  serializeWorkflowDefinitionVersion,
} from "../../../../../services/workflow-definitions/definition-store.js";
import {
  parseDefinitionId,
  serializeDefinitionMeta,
  toWorkflowDefinitionWriteHttpError,
} from "../../workflow-definitions.get.js";

/**
 * Publish the draft, and say what the deployed graph's pins mean.
 *
 * `pinnedRepositoriesNotEnabled` is read AFTER the deploy, off the version the
 * store actually wrote, so the answer describes the graph that went live rather
 * than the one the editor was holding. It is the same service function
 * `workflows.publish` reports from, so an operator deploying from the editor
 * and an agent publishing over MCP are told the same thing about the same
 * graph. A failure to read the catalog must not fail a deployment that already
 * landed, so the field is simply omitted and the editor renders nothing.
 */
export default defineEventHandler(
  async (
    event,
  ): Promise<
    WorkflowDefinitionDeploymentResponse | WorkflowDefinitionDeploymentValidationResponse | undefined
  > => {
    try {
      const actor = await requireDashboardActor(event);
      const id = parseDefinitionId(event);
      const parsed = parseRequestBody(
        workflowDefinitionDeployRequestSchema,
        (await readBody(event).catch(() => null)) ?? {},
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }

      const selected = await deployWorkflowDefinitionDraft({
        definitionId: id,
        expectedDraftRevision: parsed.value.expectedDraftRevision,
        expectedDeployedVersion: parsed.value.expectedDeployedVersion,
        actor: { role: actor.role, userId: actor.userId },
      });
      const notEnabled = await getRequestRepositoryCatalogSnapshot(event)
        .then((catalog) =>
          pinnedRepositoriesNotEnabled(selected.version.definition, catalog),
        )
        .catch(() => null);
      return {
        meta: serializeDefinitionMeta(selected.definition),
        deployed: serializeWorkflowDefinitionVersion(selected.version),
        ...(notEnabled === null ? {} : { pinnedRepositoriesNotEnabled: notEnabled }),
      };
    } catch (error) {
      return toWorkflowDefinitionWriteHttpError(event, error);
    }
  },
);
