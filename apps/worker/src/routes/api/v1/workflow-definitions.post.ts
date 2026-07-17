import { createError, defineEventHandler, readBody } from "h3";
import type { WorkflowDefinition, WorkflowDefinitionDetailResponse } from "@shared/contracts";
import { env } from "../../../../env.js";
import { getDb } from "../../../db/client.js";
import { requireDashboardActor } from "../../../lib/auth/request-context.js";
import { dashboardUserLabel } from "../../../pre-pr-checks/store.js";
import { defaultWorkflowDefinition } from "../../../workflow-definition/default.js";
import {
  createWorkflowDefinitionDraft,
  getDeployedWorkflowDefinitionVersion,
  getWorkflowDefinition,
  getWorkflowDefinitionDraft,
} from "../../../workflow-definition/store.js";
import {
  serializeDefinitionMeta,
  toWorkflowDefinitionHttpError,
} from "./workflow-definitions.get.js";

type CreateSource = { kind: "default" } | { kind: "duplicate"; definitionId: number };

interface CreateBody {
  name?: unknown;
  source?: unknown;
}

function parseSource(source: unknown): CreateSource {
  if (source && typeof source === "object") {
    const kind = (source as { kind?: unknown }).kind;
    if (kind === "default") return { kind: "default" };
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
  async (event): Promise<WorkflowDefinitionDetailResponse | undefined> => {
    try {
      const actor = await requireDashboardActor(event);
      const body = (await readBody<CreateBody>(event).catch(() => null)) ?? {};
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (name.length === 0) {
        throw createError({ statusCode: 400, statusMessage: "Invalid name" });
      }
      const source = parseSource(body.source);

      const dbHandle = getDb();

      let seed: WorkflowDefinition;
      if (source.kind === "duplicate") {
        const sourceRow = await getWorkflowDefinition(dbHandle, source.definitionId);
        if (!sourceRow || sourceRow.archivedAt) {
          throw createError({ statusCode: 404, statusMessage: "Unknown definition" });
        }
        const draft = await getWorkflowDefinitionDraft(dbHandle, source.definitionId);
        const deployed = await getDeployedWorkflowDefinitionVersion(dbHandle, source.definitionId);
        seed = draft?.draft ?? deployed?.definition ?? defaultWorkflowDefinition({ includeReview: env.ENABLE_REVIEW_PHASE });
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

      return {
        meta: serializeDefinitionMeta(created.definition, null),
        draft: created.draft,
        layout: created.definition.layout,
        deployed: null,
        deployments: [],
        current: null,
        versions: [],
      };
    } catch (error) {
      toWorkflowDefinitionHttpError(error);
    }
  },
);
