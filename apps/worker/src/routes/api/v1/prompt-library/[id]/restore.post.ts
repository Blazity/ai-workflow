import { createError, defineEventHandler, readBody } from "h3";
import {
  parseRequestBody,
  promptLibraryRestoreRequestSchema,
  type PromptLibrarySaveResponse,
} from "@shared/contracts";
import { requireDashboardActor } from "../../../../../services/auth/index.js";
import { restorePromptEntryVersion } from "../../../../../services/prompts/index.js";
import { parsePromptId, toPromptLibraryHttpError } from "../../prompt-library.get.js";

export default defineEventHandler(
  async (event): Promise<PromptLibrarySaveResponse | undefined> => {
    try {
      const actor = await requireDashboardActor(event);
      const id = parsePromptId(event);
      const parsed = parseRequestBody(
        promptLibraryRestoreRequestSchema,
        (await readBody(event).catch(() => null)) ?? {},
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }

      return await restorePromptEntryVersion({
        promptId: id,
        version: parsed.value.version,
        writer: { role: actor.role, userId: actor.userId },
      });
    } catch (error) {
      toPromptLibraryHttpError(error);
    }
  },
);
