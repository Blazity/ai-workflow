import { createError, defineEventHandler, readBody } from "h3";
import type { PromptLibraryDetailResponse } from "@shared/contracts";
import { getDb } from "../../../../db/client.js";
import { requireDashboardActor } from "../../../../lib/auth/request-context.js";
import { dashboardUserLabel } from "../../../../pre-pr-checks/store.js";
import {
  listPromptVersionRows,
  serializePromptMeta,
  serializePromptVersion,
  updatePromptMeta,
} from "../../../../prompt-library/store.js";
import { parsePromptId, toPromptLibraryHttpError } from "../prompt-library.get.js";

interface PatchBody {
  name?: unknown;
  description?: unknown;
  tags?: unknown;
}

export default defineEventHandler(
  async (event): Promise<PromptLibraryDetailResponse | undefined> => {
    try {
      const actor = await requireDashboardActor(event);
      const id = parsePromptId(event);
      const body = (await readBody<PatchBody>(event).catch(() => null)) ?? {};

      if (body.name !== undefined && typeof body.name !== "string") {
        throw createError({ statusCode: 400, statusMessage: "Invalid name" });
      }
      if (body.description !== undefined && body.description !== null && typeof body.description !== "string") {
        throw createError({ statusCode: 400, statusMessage: "Invalid description" });
      }
      if (body.tags !== undefined && !Array.isArray(body.tags)) {
        throw createError({ statusCode: 400, statusMessage: "Invalid tags" });
      }

      const dbHandle = getDb();
      const versions = (await listPromptVersionRows(dbHandle, id)).map(serializePromptVersion);
      const current = versions[0];
      if (!current) {
        // Orphan (or unknown id): no head version to return, so 404 before
        // mutating the parent meta. Same statusMessage as the missing-id path.
        throw createError({ statusCode: 404, statusMessage: "Unknown prompt" });
      }

      const updated = await updatePromptMeta(dbHandle, {
        promptId: id,
        name: body.name as string | undefined,
        description: body.description as string | null | undefined,
        tags: body.tags as string[] | undefined,
        actor: {
          role: actor.role,
          id: actor.userId,
          label: await dashboardUserLabel(dbHandle, actor.userId),
        },
      });

      return {
        meta: serializePromptMeta(updated, current.version),
        current,
        versions,
      };
    } catch (error) {
      toPromptLibraryHttpError(error);
    }
  },
);
