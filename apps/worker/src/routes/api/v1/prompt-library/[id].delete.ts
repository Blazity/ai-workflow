import { createError, defineEventHandler } from "h3";
import type { PromptLibraryDetailResponse } from "@shared/contracts";
import { getDb } from "../../../../db/client.js";
import { requireDashboardActor } from "../../../../lib/auth/request-context.js";
import { dashboardUserLabel } from "../../../../pre-pr-checks/store.js";
import {
  archivePrompt,
  listPromptVersionRows,
  serializePromptMeta,
  serializePromptVersion,
} from "../../../../prompt-library/store.js";
import { parsePromptId, toPromptLibraryHttpError } from "../prompt-library.get.js";

export default defineEventHandler(
  async (event): Promise<PromptLibraryDetailResponse | undefined> => {
    try {
      const actor = await requireDashboardActor(event);
      const id = parsePromptId(event);
      const dbHandle = getDb();
      // Orphan guard BEFORE mutating: a prompt with no version rows has no head
      // to return and must not be archived, so 404 like a missing id. Archiving
      // touches only the parent meta, so these rows are the response as-is.
      const versions = (await listPromptVersionRows(dbHandle, id)).map(serializePromptVersion);
      const current = versions[0];
      if (!current) {
        throw createError({ statusCode: 404, statusMessage: "Unknown prompt" });
      }

      const archived = await archivePrompt(dbHandle, {
        promptId: id,
        actor: {
          role: actor.role,
          id: actor.userId,
          label: await dashboardUserLabel(dbHandle, actor.userId),
        },
      });

      return {
        meta: serializePromptMeta(archived, current.version),
        current,
        versions,
      };
    } catch (error) {
      toPromptLibraryHttpError(error);
    }
  },
);
