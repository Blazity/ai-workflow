import {
  createError,
  defineEventHandler,
  readBody,
  setResponseHeader,
  setResponseStatus,
} from "h3";
import type { WorkflowDefinitionMigrationResponse } from "@shared/contracts";
import { getDb } from "../../../../../db/client.js";
import {
  requireDashboardActor,
} from "../../../../../lib/auth/request-context.js";
import { canEditWorkflowDefinitions } from "../../../../../lib/auth/roles.js";
import { dashboardUserLabel } from "../../../../../pre-pr-checks/store.js";
import {
  saveWorkflowDefinitionDraft,
} from "../../../../../workflow-definition/store.js";
import { ensureMigratedHarnessProfiles } from "../../../../../workflow-definition/v2-migration-harness-profiles.js";
import { prepareWorkflowDefinitionV2Migration } from "../../../../../workflow-definition/v2-migration.js";
import { validateWorkflowDefinitionCandidateWithPromptAuthoring } from "../../../../../workflow-definition/prompt-authoring.js";
import {
  parseDefinitionId,
  serializeDefinitionMeta,
  toWorkflowDefinitionHttpError,
} from "../../workflow-definitions.get.js";

interface MigrateBody {
  mode?: unknown;
  sourceVersion?: unknown;
  targetSchemaVersion?: unknown;
  expectedDraftRevision?: unknown;
  expectedConversionHash?: unknown;
}

export default defineEventHandler(
  async (
    event,
  ): Promise<WorkflowDefinitionMigrationResponse | undefined> => {
    try {
      setResponseHeader(event, "Cache-Control", "private, no-store");
      const actor = await requireDashboardActor(event);
      const definitionId = parseDefinitionId(event);
      const body =
        (await readBody<MigrateBody>(event).catch(() => null)) ?? {};
      const mode =
        body.mode === "preview" || body.mode === "apply" ? body.mode : null;
      if (!mode) {
        throw createError({
          statusCode: 400,
          statusMessage: "Invalid migration mode",
        });
      }
      if (
        typeof body.sourceVersion !== "number" ||
        !Number.isInteger(body.sourceVersion) ||
        body.sourceVersion <= 0
      ) {
        throw createError({
          statusCode: 400,
          statusMessage: "Invalid source version",
        });
      }
      if (body.targetSchemaVersion !== 2) {
        throw createError({
          statusCode: 400,
          statusMessage: "Target schema version must be 2",
        });
      }
      if (
        typeof body.expectedDraftRevision !== "number" ||
        !Number.isInteger(body.expectedDraftRevision) ||
        body.expectedDraftRevision < 0
      ) {
        throw createError({
          statusCode: 400,
          statusMessage: "Invalid draft revision",
        });
      }
      if (
        mode === "apply" &&
        (typeof body.expectedConversionHash !== "string" ||
          !/^[a-f0-9]{64}$/.test(body.expectedConversionHash))
      ) {
        throw createError({
          statusCode: 400,
          statusMessage: "Invalid conversion hash",
        });
      }
      if (mode === "apply" && !canEditWorkflowDefinitions(actor.role)) {
        throw createError({ statusCode: 403, statusMessage: "Forbidden" });
      }

      const dbHandle = getDb();
      const prepared = await prepareWorkflowDefinitionV2Migration(dbHandle, {
        definitionId,
        sourceVersion: body.sourceVersion,
        expectedDraftRevision: body.expectedDraftRevision,
      });
      const preview = prepared.result;
      if (mode === "preview") return { mode, ...preview };

      if (preview.blockers.length > 0 || !preview.definition) {
        setResponseStatus(event, 422, "Workflow migration is blocked");
        return {
          mode,
          ...preview,
          error: "Workflow migration is blocked",
        };
      }
      if (preview.conversionHash !== body.expectedConversionHash) {
        throw createError({
          statusCode: 409,
          statusMessage:
            "Migration resolution changed; preview the migration again",
        });
      }

      await ensureMigratedHarnessProfiles(dbHandle, {
        plans: prepared.harnessProfiles,
        actor: {
          organizationId: actor.organizationId,
          role: actor.role,
          id: actor.userId,
        },
      });
      const validation =
        await validateWorkflowDefinitionCandidateWithPromptAuthoring(
          dbHandle,
          preview.definition,
        );
      if (!validation.response.valid || !validation.parsed) {
        setResponseStatus(event, 422, "Workflow migration is blocked");
        return {
          mode,
          ...preview,
          definition: null,
          conversionHash: null,
          blockers: validation.response.issues.map((issue) => ({
            code: `migration.target.${issue.code}`,
            message: `Converted v2 workflow is not deployable: ${issue.message}`,
            nodeId: issue.nodeId,
            ...(issue.path === undefined ? {} : { path: issue.path }),
          })),
          error: "Workflow migration is blocked",
        };
      }

      const saved = await saveWorkflowDefinitionDraft(dbHandle, {
        definitionId,
        definition: validation.parsed,
        expectedDraftRevision: body.expectedDraftRevision,
        actor: {
          role: actor.role,
          id: actor.userId,
          label: await dashboardUserLabel(dbHandle, actor.userId),
        },
      });
      if (saved.draft.schemaVersion !== 2) {
        throw new Error("Applied migration did not produce a v2 draft");
      }
      return {
        mode,
        ...preview,
        meta: serializeDefinitionMeta(saved.definition),
        draft: saved.draft,
      };
    } catch (error) {
      toWorkflowDefinitionHttpError(error);
    }
  },
);
