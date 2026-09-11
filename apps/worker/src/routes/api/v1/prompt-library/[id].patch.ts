import { createError, defineEventHandler, readBody } from "h3";
import {
  parseRequestBody,
  promptLibraryUpdateMetaRequestSchema,
  type PromptLibraryDetailResponse,
} from "@shared/contracts";
import { requireDashboardActor } from "../../../../services/auth/request-context.js";
import {
  updatePromptEntryMeta,
} from "../../../../services/prompts/prompt-library-writes.js";
import { parsePromptId, toPromptLibraryHttpError } from "../prompt-library.get.js";

export default defineEventHandler(
  async (event): Promise<PromptLibraryDetailResponse | undefined> => {
    try {
      const actor = await requireDashboardActor(event);
      const id = parsePromptId(event);
      const parsed = parseRequestBody(
        promptLibraryUpdateMetaRequestSchema,
        (await readBody(event).catch(() => null)) ?? {},
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }
      const body = parsed.value;

      const updated = await updatePromptEntryMeta({
        promptId: id,
        name: body.name,
        description: body.description,
        tags: body.tags,
        writer: { role: actor.role, userId: actor.userId },
      });
      if (!updated) {
        throw createError({ statusCode: 404, statusMessage: "Unknown prompt" });
      }
      return updated;
    } catch (error) {
      toPromptLibraryHttpError(error);
    }
  },
);
