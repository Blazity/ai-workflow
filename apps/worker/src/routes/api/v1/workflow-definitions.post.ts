import {
  createError,
  defineEventHandler,
  readBody,
  setResponseHeader,
} from "h3";
import type {
  WorkflowDefinition,
  WorkflowDefinitionDetailResponse,
} from "@shared/contracts";
import { RETIRED_SCHEMA_MESSAGE } from "@shared/contracts";
import { env } from "../../../../env.js";
import { getDb } from "../../../db/client.js";
import { getCurrentSystemHarnessProfileReference } from "../../../harness-profiles/store.js";
import { requireDashboardActor } from "../../../lib/auth/request-context.js";
import { canEditWorkflowDefinitions } from "../../../lib/auth/roles.js";
import { dashboardUserLabel } from "../../../pre-pr-checks/store.js";
import { defaultWorkflowDefinitionV2 } from "../../../workflow-definition/default.js";
import { workflowDefinitionTemplate } from "../../../workflow-definition/templates.js";
import {
  createWorkflowDefinitionDraft,
  WorkflowDefinitionStoreError,
  getCurrentWorkflowDefinitionVersion,
  getDeployedWorkflowDefinitionVersion,
  getWorkflowDefinition,
  getWorkflowDefinitionDraft,
  serializeWorkflowDefinitionVersion,
} from "../../../workflow-definition/store.js";
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
  ): Promise<WorkflowDefinitionDetailResponse | undefined> => {
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

      const dbHandle = getDb();
      const currentSystemProfile =
        await getCurrentSystemHarnessProfileReference(
          dbHandle,
          env.AGENT_KIND,
        );

      let seed: WorkflowDefinition;
      if (source.kind === "duplicate") {
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
        const current = await getCurrentWorkflowDefinitionVersion(
          dbHandle,
          source.definitionId,
        );
        const storedSource = deployed ?? current;
        if (!draft && storedSource?.schema === "legacy-v1") {
          throw new WorkflowDefinitionStoreError(409, RETIRED_SCHEMA_MESSAGE);
        }
        seed =
          draft?.draft ??
          (storedSource?.schema === "v2" ? storedSource.definition : undefined) ??
          defaultWorkflowDefinitionV2({
            includeReview: env.ENABLE_REVIEW_PHASE,
            includeLeakReview: env.ENABLE_LEAK_REVIEW,
            provider: env.AGENT_KIND,
            profileReference: currentSystemProfile,
          });
      } else if (source.kind === "template") {
        const template = workflowDefinitionTemplate(source.templateId, {
          includeReview: env.ENABLE_REVIEW_PHASE,
          includeLeakReview: env.ENABLE_LEAK_REVIEW,
          provider: env.AGENT_KIND,
          profileReference: currentSystemProfile,
        });
        if (!template) {
          throw createError({ statusCode: 400, statusMessage: "Unknown template" });
        }
        seed = template.definition;
      } else {
        seed = defaultWorkflowDefinitionV2({
          includeReview: env.ENABLE_REVIEW_PHASE,
          includeLeakReview: env.ENABLE_LEAK_REVIEW,
          provider: env.AGENT_KIND,
          profileReference: currentSystemProfile,
        });
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
