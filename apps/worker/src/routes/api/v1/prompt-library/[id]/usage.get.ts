import { defineEventHandler } from "h3";
import type { PromptLibraryUsageResponse } from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../../services/auth/request-context.js";
import {
  readPromptUsage,
} from "../../../../../services/prompts/prompt-library-reads.js";
import { parsePromptId } from "../../prompt-library.get.js";

export default defineEventHandler(async (event): Promise<PromptLibraryUsageResponse | undefined> => {
  try {
    await requireDashboardActor(event);
    return await readPromptUsage(parsePromptId(event));
  } catch (error) {
    toHttpError(error);
  }
});
