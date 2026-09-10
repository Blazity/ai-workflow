import { createError, defineEventHandler, readBody } from "h3";
import {
  parseRequestBody,
  promptLibrarySaveVersionRequestSchema,
  type PromptLibrarySaveResponse,
} from "@shared/contracts";
import { requireDashboardActor } from "../../../../services/auth/index.js";
import { savePromptEntryVersion } from "../../../../services/prompts/index.js";
import { parsePromptId, toPromptLibraryHttpError } from "../prompt-library.get.js";

export default defineEventHandler(
  async (event): Promise<PromptLibrarySaveResponse | undefined> => {
    try {
      const actor = await requireDashboardActor(event);
      const id = parsePromptId(event);
      const parsed = parseRequestBody(
        promptLibrarySaveVersionRequestSchema,
        (await readBody(event).catch(() => null)) ?? {},
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }
      const body = parsed.value;

      return await savePromptEntryVersion({
        promptId: id,
        body: body.body,
        slots: body.slots,
        writer: { role: actor.role, userId: actor.userId },
      });
    } catch (error) {
      toPromptLibraryHttpError(error);
    }
  },
);
