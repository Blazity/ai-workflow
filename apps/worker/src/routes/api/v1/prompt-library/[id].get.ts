import { createError, defineEventHandler } from "h3";
import type { PromptLibraryDetailResponse } from "@shared/contracts";
import { getDb } from "../../../../db/client.js";
import { requireDashboardActor, toHttpError } from "../../../../lib/auth/request-context.js";
import {
  getPrompt,
  listPromptVersionRows,
  serializePromptMeta,
  serializePromptVersion,
} from "../../../../prompt-library/store.js";
import { parsePromptId } from "../prompt-library.get.js";

export default defineEventHandler(
  async (event): Promise<PromptLibraryDetailResponse | undefined> => {
    try {
      await requireDashboardActor(event);
      const id = parsePromptId(event);
      const dbHandle = getDb();

      // Serves archived prompts too: the library UI opens their detail behind
      // the "Archived" toggle and editor provenance chips deep-link into them.
      // 404 is reserved for an id that never existed.
      const row = await getPrompt(dbHandle, id);
      if (!row) {
        throw createError({ statusCode: 404, statusMessage: "Unknown prompt" });
      }

      const versions = (await listPromptVersionRows(dbHandle, id)).map(serializePromptVersion);
      const current = versions[0]!;
      return {
        meta: serializePromptMeta(row, current.version),
        current,
        versions,
      };
    } catch (error) {
      toHttpError(error);
    }
  },
);
