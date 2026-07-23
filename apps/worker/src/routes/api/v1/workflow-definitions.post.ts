import {
  createError,
  defineEventHandler,
  readBody,
  setResponseHeader,
  setResponseStatus,
} from "h3";
import type {
  WorkflowDefinition,
  WorkflowDefinitionDetailResponse,
  WorkflowDefinitionDuplicateMigrationBlockedResponse,
} from "@shared/contracts";
import { env } from "../../../../env.js";
import { getDb } from "../../../db/client.js";
import { requireDashboardActor } from "../../../lib/auth/request-context.js";
import { canEditWorkflowDefinitions } from "../../../lib/auth/roles.js";
import { dashboardUserLabel } from "../../../pre-pr-checks/store.js";
import { defaultWorkflowDefinition } from "../../../workflow-definition/default.js";
import { workflowDefinitionTemplate } from "../../../workflow-definition/templates.js";
import {
  createWorkflowDefinitionDraft,
  getCurrentWorkflowDefinitionVersion,
  getDeployedWorkflowDefinitionVersion,
  getRawWorkflowDefinitionVersion,
  getWorkflowDefinition,
  getWorkflowDefinitionDraft,
  getWorkflowDefinitionRawState,
  serializeWorkflowDefinitionVersion,
} from "../../../workflow-definition/store.js";
import { upgradeStoredWorkflowDefinition } from "../../../workflow-definition/schema.js";
import {
  convertWorkflowDefinitionV1ToV2WithPromptResolution,
  previewWorkflowDefinitionV2Migration,
} from "../../../workflow-definition/v2-migration.js";
import {
  serializeDefinitionMeta,
  toWorkflowDefinitionHttpError,
} from "./workflow-definitions.get.js";

type CreateSource =
  | { kind: "default" }
  | { kind: "template"; templateId: string }
  | { kind: "duplicate"; definitionId: number };

interface CreateBody {
  name?: unknown;
  source?: unknown;
  targetSchemaVersion?: unknown;
}

function parseSource(source: unknown): CreateSource {
  if (source && typeof source === "object") {
    const kind = (source as { kind?: unknown }).kind;
    if (kind === "default") return { kind: "default" };
    if (kind === "template") {
      const templateId = (source as { templateId?: unknown }).templateId;
      if (typeof templateId === "string" && templateId.length > 0) {
        return { kind: "template", templateId };
      }
    }
    if (kind === "duplicate") {
      const definitionId = (source as { definitionId?: unknown }).definitionId;
      if (typeof definitionId === "number" && Number.isInteger(definitionId) && definitionId > 0) {
        return { kind: "duplicate", definitionId };
      }
    }
  }
  throw createError({ statusCode: 400, statusMessage: "Invalid source" });
}

export default defineEventHandler(
  async (
    event,
  ): Promise<
    | WorkflowDefinitionDetailResponse
    | WorkflowDefinitionDuplicateMigrationBlockedResponse
    | undefined
  > => {
    try {
      setResponseHeader(event, "Cache-Control", "private, no-store");
      const actor = await requireDashboardActor(event);
      if (!canEditWorkflowDefinitions(actor.role)) {
        throw createError({ statusCode: 403, statusMessage: "Forbidden" });
      }
      const body = (await readBody<CreateBody>(event).catch(() => null)) ?? {};
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (name.length === 0) {
        throw createError({ statusCode: 400, statusMessage: "Invalid name" });
      }
      const source = parseSource(body.source);
      if (
        body.targetSchemaVersion !== undefined &&
        body.targetSchemaVersion !== 2
      ) {
        throw createError({
          statusCode: 400,
          statusMessage: "Target schema version must be 2",
        });
      }
      if (
        body.targetSchemaVersion === 2 &&
        source.kind !== "duplicate"
      ) {
        throw createError({
          statusCode: 400,
          statusMessage:
            "Target schema version is supported only when duplicating a workflow",
        });
      }

      const dbHandle = getDb();

      let seed: WorkflowDefinition;
      if (source.kind === "duplicate") {
        if (body.targetSchemaVersion === 2) {
          const sourceRow = await getWorkflowDefinitionRawState(
            dbHandle,
            source.definitionId,
          );
          if (!sourceRow || sourceRow.archivedAt) {
            throw createError({
              statusCode: 404,
              statusMessage: "Unknown definition",
            });
          }
          if (sourceRow.draftRevision === 0) {
            const fallback = defaultWorkflowDefinition({
              includeReview: env.ENABLE_REVIEW_PHASE,
            });
            const migration =
              await convertWorkflowDefinitionV1ToV2WithPromptResolution(
                dbHandle,
                {
                  sourceDefinitionId: source.definitionId,
                  sourceVersion: 0,
                  definition: fallback,
                },
              );
            if (!migration.definition) {
              setResponseStatus(event, 422, "Workflow migration is blocked");
              return {
                ...migration,
                error: "Workflow migration is blocked",
              };
            }
            seed = migration.definition;
          } else {
            const raw = await getRawWorkflowDefinitionVersion(
              dbHandle,
              source.definitionId,
              sourceRow.draftRevision,
            );
            if (!raw) {
              throw createError({
                statusCode: 404,
                statusMessage: "Unknown definition",
              });
            }
            if (
              raw.definition !== null &&
              typeof raw.definition === "object" &&
              "schemaVersion" in raw.definition &&
              raw.definition.schemaVersion === 2
            ) {
              seed = upgradeStoredWorkflowDefinition(raw.definition);
            } else {
              const migration = await previewWorkflowDefinitionV2Migration(
                dbHandle,
                {
                  definitionId: source.definitionId,
                  sourceVersion: sourceRow.draftRevision,
                  expectedDraftRevision: sourceRow.draftRevision,
                },
              );
              if (!migration.definition) {
                setResponseStatus(event, 422, "Workflow migration is blocked");
                return {
                  ...migration,
                  error: "Workflow migration is blocked",
                };
              }
              seed = migration.definition;
            }
          }
        } else {
          const sourceRow = await getWorkflowDefinition(
            dbHandle,
            source.definitionId,
          );
          if (!sourceRow || sourceRow.archivedAt) {
            throw createError({
              statusCode: 404,
              statusMessage: "Unknown definition",
            });
          }
          const draft = await getWorkflowDefinitionDraft(
            dbHandle,
            source.definitionId,
          );
          const deployed = await getDeployedWorkflowDefinitionVersion(
            dbHandle,
            source.definitionId,
          );
          seed =
            draft?.draft ??
            deployed?.definition ??
            defaultWorkflowDefinition({
              includeReview: env.ENABLE_REVIEW_PHASE,
            });
        }
      } else if (source.kind === "template") {
        const template = workflowDefinitionTemplate(source.templateId, {
          includeReview: env.ENABLE_REVIEW_PHASE,
        });
        if (!template) {
          throw createError({ statusCode: 400, statusMessage: "Unknown template" });
        }
        seed = template.definition;
      } else {
        seed = defaultWorkflowDefinition({ includeReview: env.ENABLE_REVIEW_PHASE });
      }

      const created = await createWorkflowDefinitionDraft(dbHandle, {
        name,
        seed,
        actor: {
          role: actor.role,
          id: actor.userId,
          label: await dashboardUserLabel(dbHandle, actor.userId),
        },
      });
      const current = await getCurrentWorkflowDefinitionVersion(
        dbHandle,
        created.definition.id,
      );

      return {
        meta: serializeDefinitionMeta(created.definition),
        draft: created.draft,
        layout: created.definition.layout,
        deployed: null,
        current: null,
        versions: current ? [serializeWorkflowDefinitionVersion(current)] : [],
      };
    } catch (error) {
      toWorkflowDefinitionHttpError(error);
    }
  },
);
