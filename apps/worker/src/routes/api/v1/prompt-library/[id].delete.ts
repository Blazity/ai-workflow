import { createError, defineEventHandler } from "h3";
import type { PromptLibraryDetailResponse } from "@shared/contracts";
import { requireDashboardActor } from "../../../../services/auth/request-context.js";
import {
  archivePromptEntry,
} from "../../../../services/prompts/prompt-library-writes.js";
import { parsePromptId, toPromptLibraryHttpError } from "../prompt-library.get.js";

export default defineEventHandler(
  async (event): Promise<PromptLibraryDetailResponse | undefined> => {
    try {
      const actor = await requireDashboardActor(event);
      const archived = await archivePromptEntry({
        promptId: parsePromptId(event),
        writer: { role: actor.role, userId: actor.userId },
      });
      if (!archived) {
        throw createError({ statusCode: 404, statusMessage: "Unknown prompt" });
      }
      return archived;
    } catch (error) {
      toPromptLibraryHttpError(error);
    }
  },
);
