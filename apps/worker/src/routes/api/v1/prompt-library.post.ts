import { createError, defineEventHandler, readBody } from "h3";
import {
  parseRequestBody,
  promptLibraryCreateRequestSchema,
  type PromptLibraryDetailResponse,
} from "@shared/contracts";
import { requireDashboardActor } from "../../../services/auth/request-context.js";
import { createPromptEntry } from "../../../services/prompts/prompt-library-writes.js";
import { toPromptLibraryHttpError } from "./prompt-library.get.js";

export default defineEventHandler(
  async (event): Promise<PromptLibraryDetailResponse | undefined> => {
    try {
      const actor = await requireDashboardActor(event);
      const parsed = parseRequestBody(
        promptLibraryCreateRequestSchema,
        (await readBody(event).catch(() => null)) ?? {},
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }
      const body = parsed.value;

      return await createPromptEntry({
        name: body.name,
        body: body.body,
        slots: body.slots,
        description: body.description,
        tags: body.tags,
        writer: { role: actor.role, userId: actor.userId },
      });
    } catch (error) {
      toPromptLibraryHttpError(error);
    }
  },
);
