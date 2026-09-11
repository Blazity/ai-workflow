import { createError, defineEventHandler } from "h3";
import type { PromptLibraryDetailResponse } from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../services/auth/request-context.js";
import { readPromptDetail } from "../../../../services/prompts/prompt-library-reads.js";
import { parsePromptId } from "../prompt-library.get.js";

export default defineEventHandler(
  async (event): Promise<PromptLibraryDetailResponse | undefined> => {
    try {
      await requireDashboardActor(event);
      const detail = await readPromptDetail(parsePromptId(event));
      if (!detail) {
        throw createError({ statusCode: 404, statusMessage: "Unknown prompt" });
      }
      return detail;
    } catch (error) {
      toHttpError(error);
    }
  },
);
